use std::collections::{HashMap, HashSet};
use std::time::{Duration, SystemTime};

use shared_proto::ProfileId;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct PendingPair {
    pub profile_id: ProfileId,
    pub confirmation_code: String,
    pub expires_at: SystemTime,
}

#[derive(Debug, Default)]
pub struct PairingRegistry {
    paired_profiles: HashSet<ProfileId>,
    pending: HashMap<Uuid, PendingPair>,
}

impl PairingRegistry {
    pub fn begin_for(
        &mut self,
        request_id: Uuid,
        profile_id: ProfileId,
        confirmation_code: String,
        expires_at: SystemTime,
    ) {
        self.prune_expired();
        // A profile may have only one live confirmation challenge. Reconnects
        // replace their own stale challenge instead of accumulating codes.
        self.pending
            .retain(|_, pending| pending.profile_id != profile_id);
        self.pending.insert(
            request_id,
            PendingPair {
                profile_id,
                confirmation_code,
                expires_at,
            },
        );
    }

    pub fn begin(&mut self, profile_id: ProfileId, confirmation_code: String) -> Uuid {
        let request_id = Uuid::new_v4();
        self.begin_for(
            request_id,
            profile_id,
            confirmation_code,
            SystemTime::now() + Duration::from_secs(120),
        );
        request_id
    }

    /// Atomically create a challenge only when this profile is still unpaired.
    pub fn begin_if_unpaired(
        &mut self,
        request_id: Uuid,
        profile_id: ProfileId,
        confirmation_code: String,
        expires_at: SystemTime,
    ) -> bool {
        self.prune_expired();
        if self.paired_profiles.contains(&profile_id) {
            return false;
        }
        self.begin_for(request_id, profile_id, confirmation_code, expires_at);
        true
    }

    pub fn approve(
        &mut self,
        request_id: Uuid,
        profile_id: ProfileId,
        confirmation_code: &str,
    ) -> bool {
        self.prune_expired();
        let Some(pending) = self.pending.remove(&request_id) else {
            return false;
        };
        if pending.profile_id != profile_id || pending.confirmation_code != confirmation_code {
            return false;
        }
        let paired = self.paired_profiles.insert(pending.profile_id);
        self.pending
            .retain(|_, other| other.profile_id != pending.profile_id);
        paired
    }

    pub fn is_paired(&self, profile_id: ProfileId) -> bool {
        self.paired_profiles.contains(&profile_id)
    }

    pub fn paired_count(&self) -> usize {
        self.paired_profiles.len()
    }

    pub fn pending_codes(&mut self) -> Vec<String> {
        self.prune_expired();
        self.pending
            .values()
            .map(|pending| pending.confirmation_code.clone())
            .collect()
    }

    pub fn revoke(&mut self, profile_id: ProfileId) -> bool {
        self.paired_profiles.remove(&profile_id)
    }

    fn prune_expired(&mut self) {
        let now = SystemTime::now();
        self.pending.retain(|_, pending| pending.expires_at > now);
    }
}
