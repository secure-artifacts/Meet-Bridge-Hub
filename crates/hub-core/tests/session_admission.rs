#![allow(clippy::unwrap_used, clippy::expect_used)]

use meet_bridge_hub_core::{HubConfig, HubService};
use shared_proto::ChannelId;
use uuid::Uuid;

#[test]
fn admits_a_loopback_audio_session() {
    let hub = HubService::new(HubConfig::default());
    let admission = hub
        .admit_session(Uuid::new_v4(), Uuid::new_v4(), ChannelId::CHANNEL_1, 1)
        .unwrap();
    assert!(admission.websocket_url.starts_with("ws://127.0.0.1:"));
    assert!(!admission.session_secret_b64.is_empty());
    assert_eq!(hub.status().active_sessions, 1);
}

#[test]
fn rejects_channels_outside_the_three_channel_contract() {
    let hub = HubService::new(HubConfig::default());
    let result = hub.admit_session(Uuid::new_v4(), Uuid::new_v4(), ChannelId(4), 1);
    assert!(result.is_err());
}

#[test]
fn emergency_stop_revokes_every_session() {
    let hub = HubService::new(HubConfig::default());
    hub.admit_session(Uuid::new_v4(), Uuid::new_v4(), ChannelId::CHANNEL_1, 1)
        .unwrap();
    hub.admit_session(Uuid::new_v4(), Uuid::new_v4(), ChannelId::CHANNEL_2, 1)
        .unwrap();
    assert_eq!(hub.revoke_all_sessions(), 2);
    assert_eq!(hub.status().active_sessions, 0);
}
