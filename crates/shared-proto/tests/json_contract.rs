use meet_bridge_shared_proto::*;
use uuid::Uuid;

#[test]
fn test_hello_json_roundtrip() {
    let hello = Hello {
        request_id: Uuid::new_v4(),
        profile_id: Uuid::new_v4(),
        profile_public_key_b64: "dGVzdF9wdWJrZXk=".to_string(),
        extension_version: "1.0.0".to_string(),
        protocol: ProtocolRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 1, minor: 0 },
        },
        client_nonce_b64: "bm9uY2U=".to_string(),
        capabilities: vec!["tabCapture".to_string()],
    };

    let req = NativeRequest::Hello(hello);
    let json_str = serde_json::to_string(&req).expect("serialize");
    assert!(json_str.contains("\"type\":\"Hello\""));

    let de: NativeRequest = serde_json::from_str(&json_str).expect("deserialize");
    match de {
        NativeRequest::Hello(h) => {
            assert_eq!(h.extension_version, "1.0.0");
        }
        _ => panic!("Expected Hello"),
    }
}
