use serde::Serialize;

const REPO_OWNER: &str = "Altairu";
const REPO_NAME: &str = "Altair_module_system_control";
const BIN_NAME: &str = "altair_module_system_control";

#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub release_notes: String,
    pub message: String,
}

/// セマンティックバージョンの比較 (latest > current なら true)
fn is_newer_version(current: &str, latest: &str) -> bool {
    let parse = |s: &str| -> Vec<u32> {
        s.trim_start_matches('v')
            .split('.')
            .map(|p| p.parse::<u32>().unwrap_or(0))
            .collect()
    };
    let c = parse(current);
    let l = parse(latest);
    for i in 0..3 {
        let cv = c.get(i).copied().unwrap_or(0);
        let lv = l.get(i).copied().unwrap_or(0);
        if lv > cv {
            return true;
        } else if lv < cv {
            return false;
        }
    }
    false
}

/// GitHub Releases の最新バージョンを確認 (self_update クレート使用)
pub fn check_github_update() -> UpdateCheckResult {
    let current = env!("CARGO_PKG_VERSION").to_string();

    let releases_res = self_update::backends::github::ReleaseList::configure()
        .repo_owner(REPO_OWNER)
        .repo_name(REPO_NAME)
        .build()
        .and_then(|list| list.fetch());

    match releases_res {
        Ok(releases) => {
            if let Some(latest) = releases.first() {
                let latest_ver = latest.version.trim_start_matches('v').to_string();
                let available = is_newer_version(&current, &latest_ver);
                UpdateCheckResult {
                    current_version: current.clone(),
                    latest_version: latest_ver.clone(),
                    update_available: available,
                    release_notes: latest.body.clone().unwrap_or_default(),
                    message: if available {
                        format!(
                            "新しいバージョン v{} が利用可能です (現在: v{})。",
                            latest_ver, current
                        )
                    } else {
                        format!("最新バージョン (v{}) を使用しています。", current)
                    },
                }
            } else {
                UpdateCheckResult {
                    current_version: current.clone(),
                    latest_version: current,
                    update_available: false,
                    release_notes: String::new(),
                    message: "GitHub Releases に公開されているリリースはまだありません。".to_string(),
                }
            }
        }
        Err(e) => UpdateCheckResult {
            current_version: current.clone(),
            latest_version: current,
            update_available: false,
            release_notes: String::new(),
            message: format!("アップデート確認スキップ: {}", e),
        },
    }
}

/// GitHub Releases から最新バイナリをダウンロードし、実行中の .exe を自己更新する
pub fn apply_github_update() -> Result<String, String> {
    let current = env!("CARGO_PKG_VERSION");

    let status = self_update::backends::github::Update::configure()
        .repo_owner(REPO_OWNER)
        .repo_name(REPO_NAME)
        .bin_name(BIN_NAME)
        .show_download_progress(false)
        .no_confirm(true)
        .current_version(current)
        .build()
        .map_err(|e| format!("アップデータ初期化エラー: {}", e))?
        .update()
        .map_err(|e| format!("アップデート適用エラー: {}", e))?;

    if status.updated() {
        Ok(format!(
            "バージョン v{} へのアップデートが完了しました。アプリを再起動してください。",
            status.version()
        ))
    } else {
        Ok(format!(
            "すでに最新バージョン (v{}) です。",
            status.version()
        ))
    }
}

