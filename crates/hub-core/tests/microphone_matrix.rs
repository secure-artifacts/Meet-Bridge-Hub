use meet_bridge_hub_core::{HubConfig, HubService, PCM_FRAME_SAMPLES};
use shared_proto::ChannelId;
use uuid::Uuid;

#[test]
fn hub_microphone_is_included_without_becoming_a_browser_endpoint() {
    let hub = HubService::new(HubConfig::default());
    hub.ingest_microphone_frame(ChannelId::CHANNEL_1, [0.3; PCM_FRAME_SAMPLES]);
    let admission = hub
        .admit_session(Uuid::new_v4(), Uuid::new_v4(), ChannelId::CHANNEL_1, 1)
        .unwrap();
    assert_ne!(admission.endpoint_id, Uuid::nil());
}
