use std::time::Duration;

/// 与桌面客户端一致的 API 基址（客户端常量 `apiHostName`）。
const API_BASE: &str = "https://api.pencil.dev";


#[derive(Debug)]
pub enum Verdict {
    /// 服务端确认 token 有效。
    Valid,
    /// 401/403：会话已被吊销或过期。
    Revoked,
    /// 网络不可达或响应异常，无法下结论。
    Unreachable,
}

/// 调用 `/auth/session-info`。返回 401 即客户端日志里的 “Session revoked”。
pub fn verify(token: &str, device_id: &str) -> Verdict {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout(Duration::from_secs(8))
        .build();

    let mut request = agent
        .get(&format!("{API_BASE}/auth/session-info"))
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "application/json");

    if !device_id.is_empty() {
        request = request.set("X-Device-Id", device_id);
    }

    match request.call() {
        // 200 即视为有效；正文内容不参与判定。
        Ok(_) => Verdict::Valid,
        Err(ureq::Error::Status(401, _)) | Err(ureq::Error::Status(403, _)) => Verdict::Revoked,
        Err(_) => Verdict::Unreachable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "需要网络访问 api.pencil.dev"]
    fn rejects_invalid_token() {
        match verify("not-a-real-token", "pen-switch-test") {
            Verdict::Revoked => {}
            other => panic!("expected Revoked, got {other:?}"),
        }
    }
}