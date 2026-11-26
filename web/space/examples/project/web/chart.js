// A chart's bars: the heights of a range, scaled to the tallest.
import { range, sum } from "./util.js";

export class Chart {
  constructor(n) {
    this.values = range(n).map((i) => i * i);
  }

  bars() {
    const top = Math.max(...this.values) || 1;
    return this.values.map((v) => v / top);
  }

  total() {
    return sum(this.values);
  }
}
