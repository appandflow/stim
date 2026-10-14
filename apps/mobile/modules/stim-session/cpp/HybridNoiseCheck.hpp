#pragma once

#include "HybridNoiseCheckSpec.hpp"

namespace margelo::nitro::stimsession {

class HybridNoiseCheck : public HybridNoiseCheckSpec {
public:
  HybridNoiseCheck() : HybridObject(TAG) {}

  std::vector<std::string> runVectors(const std::vector<NoiseVector>& vectors,
                                      const std::vector<FramingVector>& framing) override;
  ThroughputResult measureThroughput(double bytes, double count) override;
};

} // namespace margelo::nitro::stimsession
