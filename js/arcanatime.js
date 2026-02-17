// ArcanaTime: Real animation time accounting for server ticks (0.132s per tick)
// Formula: (ceil(castTime / 0.132) + 1) * 0.132

const TICK = 0.132;

export function arcanaTime(castSeconds) {
  if (castSeconds <= 0) return TICK; // instant cast still takes 1 tick
  return (Math.ceil(castSeconds / TICK) + 1) * TICK;
}
