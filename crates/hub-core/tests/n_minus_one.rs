use meet_bridge_hub_core::{MixEndpoint, NMinusOneMatrix, PCM_FRAME_SAMPLES};
use shared_proto::ChannelId;
use uuid::Uuid;

fn endpoint(channel_id: ChannelId) -> MixEndpoint {
    MixEndpoint {
        endpoint_id: Uuid::new_v4(),
        channel_id,
    }
}

#[test]
fn target_never_receives_its_own_input() {
    let target = endpoint(ChannelId::CHANNEL_1);
    let peer = endpoint(ChannelId::CHANNEL_1);
    let mut matrix = NMinusOneMatrix::default();
    assert!(matrix.register(target));
    assert!(matrix.register(peer));
    assert!(matrix.set_input(target, [0.75; PCM_FRAME_SAMPLES]));
    assert!(matrix.set_input(peer, [0.25; PCM_FRAME_SAMPLES]));
    assert_eq!(matrix.mix_for(target), [0.25; PCM_FRAME_SAMPLES]);
}

#[test]
fn channels_are_strictly_isolated() {
    let target = endpoint(ChannelId::CHANNEL_1);
    let same_channel_peer = endpoint(ChannelId::CHANNEL_1);
    let other_channel_peer = endpoint(ChannelId::CHANNEL_2);
    let mut matrix = NMinusOneMatrix::default();
    for item in [target, same_channel_peer, other_channel_peer] {
        assert!(matrix.register(item));
    }
    assert!(matrix.set_input(same_channel_peer, [0.25; PCM_FRAME_SAMPLES]));
    assert!(matrix.set_input(other_channel_peer, [0.90; PCM_FRAME_SAMPLES]));
    assert_eq!(matrix.mix_for(target), [0.25; PCM_FRAME_SAMPLES]);
}
