use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

/// 与桌面客户端一致的 API 基址。
const API_BASE: &str = "https://api.pencil.dev";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaFeature {
    pub key: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub used: Value,
    #[serde(default)]
    pub limit: Value,
    #[serde(default)]
    pub remaining: Value,
    #[serde(default)]
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub plan: Option<String>,
    pub billing_enabled: bool,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
    pub resets_at: Option<String>,
    pub features: Vec<QuotaFeature>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaView {
    /// ok | unavailable
    pub status: &'static str,
    pub reason: Option<String>,
    pub quota: Option<Quota>,
}

impl QuotaView {
    pub fn ok(quota: Quota) -> Self {
        Self {
            status: "ok",
            reason: None,
            quota: Some(quota),
        }
    }

    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            status: "unavailable",
            reason: Some(reason.into()),
            quota: None,
        }
    }
}

pub enum Outcome {
    Ok(Quota),
    /// 401/403：token 已失效。
    Revoked,
    Unavailable(String),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageSummary {
    #[serde(default)]
    billing_enabled: bool,
    #[serde(default)]
    period_start: Option<String>,
    #[serde(default)]
    period_end: Option<String>,
    #[serde(default)]
    resets_at: Option<String>,
    #[serde(default)]
    features: Vec<QuotaFeature>,
}

#[derive(Debug, Deserialize)]
struct Workspaces {
    #[serde(default)]
    organizations: Vec<Organization>,
}

#[derive(Debug, Deserialize)]
struct Organization {
    id: String,
    #[serde(default, rename = "isPersonal")]
    is_personal: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpgradeOptions {
    #[serde(default)]
    billing_enabled: bool,
    #[serde(default)]
    plan_name: Option<String>,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()
}

enum HttpError {
    Status(u16),
    Other(String),
}

fn get(url: &str, token: &str) -> Result<String, HttpError> {
    match agent()
        .get(url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "application/json")
        .call()
    {
        Ok(response) => response
            .into_string()
            .map_err(|err| HttpError::Other(err.to_string())),
        Err(ureq::Error::Status(code, _)) => Err(HttpError::Status(code)),
        Err(err) => Err(HttpError::Other(err.to_string())),
    }
}

/// 取当前账号的个人组织 id；失败不致命，可以退回不带 org 的请求。
fn organization_id(token: &str) -> Option<String> {
    let body = get(&format!("{API_BASE}/user/workspaces"), token).ok()?;
    let parsed: Workspaces = serde_json::from_str(&body).ok()?;
    parsed
        .organizations
        .iter()
        .find(|org| org.is_personal)
        .or_else(|| parsed.organizations.first())
        .map(|org| org.id.clone())
}

fn plan_name(token: &str, organization: Option<&str>) -> Option<(String, bool)> {
    let body = serde_json::json!({ "organizationId": organization });
    let response = agent()
        .post(&format!("{API_BASE}/public/upgrade-options"))
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
        .ok()?;
    let parsed: UpgradeOptions = response.into_json().ok()?;
    parsed
        .plan_name
        .map(|name| (name, parsed.billing_enabled))
}

fn is_auth_failure(error: &HttpError) -> bool {
    matches!(error, HttpError::Status(401) | HttpError::Status(403))
}

fn is_forbidden(error: &HttpError) -> bool {
    matches!(error, HttpError::Status(403))
}

pub fn fetch(token: &str) -> Outcome {
    let organization = organization_id(token);

    let usage_url = match organization.as_deref() {
        Some(org) => format!("{API_BASE}/usage/summary?organizationId={org}"),
        None => format!("{API_BASE}/usage/summary"),
    };

    let body = match get(&usage_url, token) {
        Ok(body) => body,
        // 组织不匹配时退回默认组织再试一次。
        Err(err) if is_forbidden(&err) && organization.is_some() => {
            match get(&format!("{API_BASE}/usage/summary"), token) {
                Ok(body) => body,
                Err(err) if is_auth_failure(&err) => return Outcome::Revoked,
                Err(HttpError::Status(code)) => {
                    return Outcome::Unavailable(format!("HTTP {code}"))
                }
                Err(HttpError::Other(message)) => return Outcome::Unavailable(message),
            }
        }
        Err(err) if is_auth_failure(&err) => return Outcome::Revoked,
        Err(HttpError::Status(code)) => return Outcome::Unavailable(format!("HTTP {code}")),
        Err(HttpError::Other(message)) => return Outcome::Unavailable(message),
    };

    let parsed: UsageSummary = match serde_json::from_str(&body) {
        Ok(parsed) => parsed,
        Err(err) => return Outcome::Unavailable(format!("额度响应解析失败：{err}")),
    };

    let (plan, billing_enabled) = match plan_name(token, organization.as_deref()) {
        Some((name, enabled)) => (Some(name), enabled),
        None => (None, parsed.billing_enabled),
    };

    Outcome::Ok(Quota {
        plan,
        billing_enabled,
        period_start: parsed.period_start,
        period_end: parsed.period_end,
        resets_at: parsed.resets_at,
        features: parsed.features,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_usage_summary_shape() {
        let body = r#"{"billingEnabled":true,"periodStart":"2026-11-01T00:00:00.000Z",
            "periodEnd":"2026-11-30T00:00:00.000Z","resetsAt":"2026-12-01T00:00:00.000Z",
            "features":[
              {"key":"mcp_usage_days","name":"Active Days","used":2,"limit":5,"remaining":3,"binary":false},
              {"key":"pen_inference","name":"Inference","used":0,"limit":"unlimited","remaining":"unlimited","binary":true}
            ]}"#;
        let parsed: UsageSummary = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.features.len(), 2);
        assert_eq!(parsed.features[0].limit, serde_json::json!(5));
        assert_eq!(parsed.features[1].limit, serde_json::json!("unlimited"));
        assert_eq!(parsed.resets_at.as_deref(), Some("2026-12-01T00:00:00.000Z"));
    }

    #[test]
    #[ignore = "需要真实 token：设置 PEN_QUOTA_TOKEN"]
    fn fetches_real_quota() {
        let Ok(token) = std::env::var("PEN_QUOTA_TOKEN") else {
            eprintln!("skip: 未设置 PEN_QUOTA_TOKEN");
            return;
        };
        match fetch(&token) {
            Outcome::Ok(quota) => {
                println!("plan={:?} resets={:?}", quota.plan, quota.resets_at);
                for feature in &quota.features {
                    println!("{} used={} limit={}", feature.key, feature.used, feature.limit);
                }
            }
            Outcome::Revoked => panic!("token 被吊销"),
            Outcome::Unavailable(reason) => panic!("不可用：{reason}"),
        }
    }
}
