use std::collections::HashMap;

use shared_proto::{ChannelId, EndpointId};

pub const PCM_FRAME_SAMPLES: usize = 480;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct MixEndpoint {
    pub endpoint_id: EndpointId,
    pub channel_id: ChannelId,
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
        let mut output = [0.0; PCM_FRAME_SAMPLES];
        if !target.channel_id.is_valid() {
            return output;
        }
        for (source, samples) in &self.latest_input {
            if *source == target || source.channel_id != target.channel_id {
                continue;
            }
            for (destination, sample) in output.iter_mut().zip(samples) {
                *destination = (*destination + *sample).clamp(-1.0, 1.0);
            }
        }
        output
    }
}
