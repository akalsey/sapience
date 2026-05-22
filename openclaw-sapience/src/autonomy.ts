import type { SapienceItem, RoutedItem, CalibrationProfile, SapienceConfig, Tier } from "./types.js";
import { getEntry, needsCalibration } from "./calibration.js";

const TIER_ORDER = ["act", "propose", "ask", "explore"] as const;

export function routeItem(
  item: SapienceItem,
  profile: CalibrationProfile,
  config: SapienceConfig
): RoutedItem {
  const entry = getEntry(profile, item.domain, item.action_class);

  if (config.learning.enabled && needsCalibration(entry, config.learning.confidenceDropThreshold)) {
    return { ...item, tier: "learning", confidence: entry?.confidence ?? 0 };
  }

  let tier = (entry?.tier ?? config.autonomy.defaultTier) as Tier;
  const confidence = entry?.confidence ?? 0;

  const floor = config.autonomy.domainFloors[item.domain];
  if (floor) {
    const tierIdx = TIER_ORDER.indexOf(tier as (typeof TIER_ORDER)[number]);
    const floorIdx = TIER_ORDER.indexOf(floor);
    if (tierIdx !== -1 && floorIdx !== -1 && tierIdx < floorIdx) tier = floor;
  }

  return { ...item, tier, confidence };
}
