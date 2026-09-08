use meet_bridge_hub_core::PairingRegistry;
use uuid::Uuid;

#[test]
fn only_a_matching_confirmation_pairs_a_profile() {
    let profile = Uuid::new_v4();
    let mut registry = PairingRegistry::default();
    let request = registry.begin(profile, "482913".to_owned());
    assert!(!registry.approve(request, profile, "000000"));
    assert!(!registry.is_paired(profile));
}

#[test]
fn a_profile_has_only_one_live_challenge_and_is_counted_after_pairing() {
    let profile = Uuid::new_v4();
    let mut registry = PairingRegistry::default();
    let stale_request = registry.begin(profile, "111111".to_owned());
    let current_request = registry.begin(profile, "222222".to_owned());

    assert_ne!(stale_request, current_request);
    assert_eq!(registry.pending_codes(), vec!["222222"]);
    assert!(registry.approve(current_request, profile, "222222"));
    assert_eq!(registry.paired_count(), 1);
    assert!(registry.pending_codes().is_empty());
}
