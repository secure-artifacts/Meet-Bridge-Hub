use std::collections::HashMap;

use shared_proto::{ChannelId, EndpointId};

pub const PCM_FRAME_SAMPLES: usize = 480;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MixEndpoint {
    pub endpoint_id: EndpointId,
    pub channel_id: ChannelId,
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn endpoint(channel_id: ChannelId) -> MixEndpoint {
        MixEndpoint {
            endpoint_id: Uuid::new_v4(),
            channel_id,
        }
    }

    #[test]
    fn excludes_same_profile_and_hub_microphone_until_explicitly_selected() {
        let mut matrix = NMinusOneMatrix::default();
        let target = endpoint(ChannelId::CHANNEL_1);
        let same_profile = endpoint(ChannelId::CHANNEL_1);
        let remote = endpoint(ChannelId::CHANNEL_1);
        let hub_mic = MixEndpoint {
            endpoint_id: Uuid::nil(),
            channel_id: ChannelId::CHANNEL_1,
        };
        for input in [target, same_profile, remote, hub_mic] {
            assert!(matrix.register(input));
        }
        assert!(matrix.set_input(same_profile, [0.5; PCM_FRAME_SAMPLES]));
        assert!(matrix.set_input(remote, [0.125; PCM_FRAME_SAMPLES]));
        assert!(matrix.set_input(hub_mic, [0.25; PCM_FRAME_SAMPLES]));
        assert_eq!(
            matrix.mix_for_excluding(target, &[same_profile, hub_mic]),
            [0.125; PCM_FRAME_SAMPLES]
        );
        assert_eq!(
            matrix.mix_for_excluding(target, &[same_profile]),
            [0.375; PCM_FRAME_SAMPLES]
        );
    }
}

#[derive(Debug, Default)]
pub struct NMinusOneMatrix {
    latest_input: HashMap<MixEndpoint, [f32; PCM_FRAME_SAMPLES]>,
}

impl NMinusOneMatrix {
    pub fn register(&mut self, endpoint: MixEndpoint) -> bool {
        if !endpoint.channel_id.is_valid() {
            return false;
        }
        self.latest_input
            .entry(endpoint)
            .or_insert([0.0; PCM_FRAME_SAMPLES]);
        true
    }

    pub fn remove(&mut self, endpoint: MixEndpoint) {
        self.latest_input.remove(&endpoint);
    }

    pub fn set_input(&mut self, endpoint: MixEndpoint, samples: [f32; PCM_FRAME_SAMPLES]) -> bool {
        let Some(slot) = self.latest_input.get_mut(&endpoint) else {
            return false;
        };
        *slot = samples;
        true
    }

    pub fn mix_for(&self, target: MixEndpoint) -> [f32; PCM_FRAME_SAMPLES] {
        self.mix_for_excluding(target, &[])
    }

    pub fn mix_for_excluding(
        &self,
        target: MixEndpoint,
        excluded: &[MixEndpoint],
    ) -> [f32; PCM_FRAME_SAMPLES] {
        let mut output = [0.0; PCM_FRAME_SAMPLES];
        if !target.channel_id.is_valid() {
            return output;
        }
        for (source, samples) in &self.latest_input {
            if *source == target
                || source.channel_id != target.channel_id
                || excluded.contains(source)
            {
                continue;
            }
            for (destination, sample) in output.iter_mut().zip(samples) {
                *destination += *sample;
            }
        }
        output.map(|sample| sample.clamp(-1.0, 1.0))
    }
}
