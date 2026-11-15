use crate::pen::session::Workspace;
use serde::Deserialize;
use std::time::Duration;

/// 与桌面客户端一致的 API 基址。
const API_BASE: &str = "https://api.pencil.dev";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // slug / profileUrl / status 保留给后续“完善资料”流程
pub struct LoginPayload {
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub profile_url: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub has_set_password: Option<bool>,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
}

fn describe(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            let message = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| {
                    value
                        .get("message")
                        .and_then(|item| item.as_str())
                        .map(str::to_string)
                })
                .unwrap_or(body);
            if message.is_empty() {
                format!("HTTP {code}")
            } else {
                format!("HTTP {code}：{message}")
            }
        }
        other => other.to_string(),
    }
}

fn post(path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    let response = agent()
        .post(&format!("{API_BASE}{path}"))
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .send_string(&body.to_string())
        .map_err(describe)?;

    if response.status() == 204 {
        return Ok(serde_json::json!({}));
    }

    response.into_json().map_err(|err| err.to_string())
}

#[derive(Debug, Deserialize)]
struct WorkspacesResponse {
    #[serde(default)]
    organizations: Vec<Organization>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Organization {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    is_personal: bool,
    #[serde(default)]
    owner_slug: Option<String>,
}

/// 取账号的个人工作区，用于补齐会话文件里的 `currentWorkspace`。
/// 缺少这个字段时 pen.dev 可能无法恢复工作区。
pub fn personal_workspace(token: &str) -> Option<Workspace> {
    let response = agent()
        .get(&format!("{API_BASE}/user/workspaces"))
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "application/json")
        .call()
        .ok()?;
    let parsed: WorkspacesResponse = response.into_json().ok()?;
    let org = parsed
        .organizations
        .iter()
        .find(|org| org.is_personal)
        .or_else(|| parsed.organizations.first())?;

    Some(Workspace {
        organization_id: Some(org.id.clone()),
        slug: org.owner_slug.clone(),
        label: Some(format!("{} workspace", org.name)),
    })
}

fn client_host() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

/// 发送邮箱验证码。
pub fn request_code(email: &str) -> Result<(), String> {
    let body = serde_json::json!({ "email": email.trim() });
    post("/auth/request-code", &body).map(|_| ())
}

/// 用验证码登录，返回服务端下发的会话。
pub fn login_with_code(email: &str, code: &str, device_id: &str) -> Result<LoginPayload, String> {
    let body = serde_json::json!({
        "method": "otp",
        "email": email.trim(),
        "code": code.trim(),
        "deviceId": device_id,
        "clientType": "desktop",
        "clientHost": client_host(),
    });

    let value = post("/auth/device-login", &body)?;
    serde_json::from_value::<LoginPayload>(value).map_err(|err| format!("登录响应解析失败：{err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "需要真实 token：设置 PEN_WORKSPACE_TOKEN"]
    fn resolves_personal_workspace() {
        let Ok(token) = std::env::var("PEN_WORKSPACE_TOKEN") else {
            eprintln!("skip: 未设置 PEN_WORKSPACE_TOKEN");
            return;
        };
        let workspace = personal_workspace(&token).expect("应能取到个人工作区");
        println!(
            "org={:?} slug={:?} label={:?}",
            workspace.organization_id, workspace.slug, workspace.label
        );
        assert!(workspace.organization_id.is_some());
    }

    #[test]
    fn parses_login_payload() {
        let payload: LoginPayload = serde_json::from_str(
            r#"{"token":"t","email":"a@example.com","slug":"a","profileUrl":"https://pen.dev/a","status":"user_with_password","hasSetPassword":true}"#,
        )
        .unwrap();
        assert_eq!(payload.email.as_deref(), Some("a@example.com"));
        assert_eq!(payload.slug.as_deref(), Some("a"));
        assert_eq!(payload.has_set_password, Some(true));
    }
}
