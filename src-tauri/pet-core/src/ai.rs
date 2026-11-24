//! 皮肤制作器 AI 功能的纯逻辑：端点校验、从模型回复里取出 JSON、输入长度限制。
//! 网络请求本身在应用层（pet/maker_ai.rs），这里不做任何 I/O。

pub const MAX_PROMPT_CHARS: usize = 500;
pub const MAX_REPLY_BYTES: usize = 200_000;

/// 把用户填写的「基础地址」规范成 chat completions 地址。
/// 只接受 https；`http` 仅限本机回环（localhost / 127.0.0.1 / [::1]，供本地模型使用）。
/// 不接受地址里的用户名密码、查询串和片段。
pub fn chat_completions_url(base: &str) -> Result<String, &'static str> {
    let base = base.trim();
    let (scheme, rest) = if let Some(r) = base.strip_prefix("https://") {
        ("https", r)
    } else if let Some(r) = base.strip_prefix("http://") {
        ("http", r)
    } else {
        return Err("endpoint-needs-https");
    };
    if rest.is_empty() || rest.contains(['?', '#', '@', ' ', '\\']) {
        return Err("endpoint-invalid");
    }
    let host_port = rest.split('/').next().unwrap_or("");
    let host = if let Some(h) = host_port.strip_prefix('[') {
        h.split(']').next().unwrap_or("")
    } else {
        host_port.split(':').next().unwrap_or("")
    };
    if host.is_empty() {
        return Err("endpoint-invalid");
    }
    if scheme == "http" && !matches!(host, "localhost" | "127.0.0.1" | "::1") {
        return Err("endpoint-needs-https");
    }
    let trimmed = base.trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("{trimmed}/chat/completions"))
    }
}

/// 从模型回复里取出第一个完整的 `{...}` JSON 对象文本（识别字符串与转义，能跳过 ``` 围栏和前后废话）。
pub fn extract_json_object(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let start = text.find('{')?;
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[start..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// 去掉首尾空白，按字符数截断。
pub fn clamp_prompt(s: &str) -> String {
    s.trim().chars().take(MAX_PROMPT_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_accept_https_and_loopback_http_only() {
        assert_eq!(chat_completions_url("https://api.example.com/v1").unwrap(), "https://api.example.com/v1/chat/completions");
        assert_eq!(chat_completions_url("https://api.example.com/v1/").unwrap(), "https://api.example.com/v1/chat/completions");
        assert_eq!(
            chat_completions_url("https://api.example.com/v1/chat/completions").unwrap(),
            "https://api.example.com/v1/chat/completions"
        );
        assert_eq!(chat_completions_url("http://localhost:11434/v1").unwrap(), "http://localhost:11434/v1/chat/completions");
        assert_eq!(chat_completions_url("http://127.0.0.1:8080").unwrap(), "http://127.0.0.1:8080/chat/completions");
        assert_eq!(chat_completions_url("http://[::1]:8080/v1").unwrap(), "http://[::1]:8080/v1/chat/completions");
    }

    #[test]
    fn endpoints_reject_plain_http_to_remote_hosts_and_tricks() {
        for bad in [
            "http://api.example.com/v1",
            "ftp://x/y",
            "api.example.com",
            "https://",
            "https://user:pw@evil.com/v1",
            "https://a.com/v1?x=1",
            "https://a.com/v1#f",
            "https://a.com/v 1",
            "http://localhost.evil.com/v1",
            "http://127.0.0.1.evil.com/v1",
            "https://:443/v1",
        ] {
            assert!(chat_completions_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn json_extraction_handles_fences_noise_strings_and_nesting() {
        assert_eq!(extract_json_object(r#"{"a":1}"#), Some(r#"{"a":1}"#));
        assert_eq!(extract_json_object("Here you go:\n```json\n{\"a\":{\"b\":2}}\n```\nEnjoy!"), Some("{\"a\":{\"b\":2}}"));
        assert_eq!(extract_json_object(r#"{"s":"} not the end { \" still string"}"#), Some(r#"{"s":"} not the end { \" still string"}"#));
        assert_eq!(extract_json_object("no json here"), None);
        assert_eq!(extract_json_object(r#"{"unterminated": 1"#), None);
    }

    #[test]
    fn prompt_is_trimmed_and_capped_by_chars() {
        assert_eq!(clamp_prompt("  hi  "), "hi");
        let long = "猫".repeat(600);
        assert_eq!(clamp_prompt(&long).chars().count(), MAX_PROMPT_CHARS);
    }
}
