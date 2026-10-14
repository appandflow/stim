#pragma once

#include "HybridNoiseCheckSpec.hpp"

namespace margelo::nitro::stimsession {

class HybridNoiseCheck : public HybridNoiseCheckSpec {
public:
  HybridNoiseCheck() : HybridObject(TAG) {}

  ThroughputResult measureThroughput(double bytes, double count) override;
};

} // namespace margelo::nitro::stimsession
