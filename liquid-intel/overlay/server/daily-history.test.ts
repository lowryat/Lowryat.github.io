import assert from "node:assert/strict";
import test from "node:test";
import {
  alignToCalendar,
  buildPanelFrom,
  cleanDailySeries,
  dateKey,
  parseCoinbaseCandles,
  parseCoinGeckoChart,
  parseGlobalSeries,
  parseKrakenOhlc,
  type DailyPoint,
} from "./daily-history";
import { buildRiskLabModel } from "./quant-routes";

const DAY = 86_400_000;
const END = Date.parse("2026-09-22T00:00:00Z");

function series(days: number, start = 100, drift = 0.001, end = END): DailyPoint[] {
  const points: DailyPoint[] = [];
  let price = start;
  for (let index = days - 1; index >= 0; index -= 1) {
    price *= Math.exp(drift + 0.02 * Math.sin(index * 1.7));
    points.push({ date: dateKey(end - index * DAY), close: price, volumeUsd: 1_000_000 });
  }
  return points;
}

test("Coinbase candles map to dated closes with USD volume", () => {
  const points = parseCoinbaseCandles([[END / 1000, 9, 11, 10, 10.5, 200], ["bad"], [END / 1000 - 86400, 9, 11, 10, 10, 100]]);
  assert.deepEqual(points, [
    { date: "2026-09-22", close: 10.5, volumeUsd: 2100 },
    { date: "2026-09-21", close: 10, volumeUsd: 1000 },
  ]);
});

test("CoinGecko charts keep the last price per day and attach that day's volume", () => {
  const points = parseCoinGeckoChart({
    prices: [[END - DAY, 1], [END, 2], [END + 3_600_000, 2.5]],
    total_volumes: [[END - DAY, 10], [END, 20]],
  });
  const byDate = new Map(points.map((point) => [point.date, point]));
  assert.equal(points.length, 3);
  const cleaned = cleanDailySeries([...points, ...series(70, 1, 0, END - 2 * DAY)], END + DAY);
  assert.equal(cleaned.points.find((point) => point.date === "2026-09-22")?.close, 2.5);
  assert.equal(byDate.get("2026-09-21")?.volumeUsd, 10);
});

test("Kraken OHLC parses string values and surfaces API errors", () => {
  const ok = parseKrakenOhlc({ error: [], result: { XXBTZUSD: [[END / 1000, "1", "2", "0.5", "1.5", "1.4", "10", 5]], last: 1 } });
  assert.deepEqual(ok, { points: [{ date: "2026-09-22", close: 1.5, volumeUsd: 14 }], error: null });
  assert.equal(parseKrakenOhlc({ error: ["EQuery:Unknown asset pair"] }).error, "EQuery:Unknown asset pair");
});

test("global liquidity series parse each provider's shape", () => {
  const seconds = END / 1000;
  assert.deepEqual(parseGlobalSeries("stablecoin_supply", [{ date: String(seconds), totalCirculatingUSD: { peggedUSD: 5 } }]), [{ date: "2026-09-22", value: 5 }]);
  assert.deepEqual(parseGlobalSeries("tvl", [{ date: seconds, tvl: 7 }]), [{ date: "2026-09-22", value: 7 }]);
  assert.deepEqual(parseGlobalSeries("dex_volume", { totalDataChart: [[seconds, 9]] }), [{ date: "2026-09-22", value: 9 }]);
  assert.deepEqual(parseGlobalSeries("fear_greed", { data: [{ value: "44", timestamp: String(seconds) }, { value: "400", timestamp: String(seconds - 86400) }] }), [{ date: "2026-09-22", value: 44 }]);
});

test("validation removes bad ticks and rejects short or stale series", () => {
  const good = series(100);
  const spiked = good.map((point, index) => (index === 50 ? { ...point, close: point.close * 3 } : point));
  const cleaned = cleanDailySeries(spiked, END + DAY);
  assert.equal(cleaned.error, null);
  assert.equal(cleaned.points.length, 99);
  assert.match(cleanDailySeries(series(20), END + DAY).error ?? "", /only 20/);
  assert.match(cleanDailySeries(series(100, 100, 0.001, END - 10 * DAY), END + DAY).error ?? "", /days old/);
});

test("calendar alignment forward-fills gaps of up to three days only", () => {
  const dates = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"];
  assert.deepEqual(alignToCalendar(dates, [{ date: "2026-09-01", value: 1 }, { date: "2026-09-06", value: 2 }]), [1, 1, 1, 1, null, 2]);
  assert.deepEqual(alignToCalendar(dates, [{ date: "2026-09-02", value: 3 }], false), [null, 3, null, null, null, null]);
});

test("the risk-lab model aligns returns and excludes assets without a full window", () => {
  const panel = buildPanelFrom(
    new Map([["BTC", { points: series(400) }], ["ETH", { points: series(400, 50, 0.0005) }], ["NEW", { points: series(90, 5) }]]),
    new Map([["stablecoin_supply", { points: series(400, 1e11, 0.0002).map((point) => ({ date: point.date, value: point.close })) }]]),
  );
  assert.equal(panel.dates.length, 400);
  const model = buildRiskLabModel(panel, 365, ["BTC", "ETH", "NEW"], "bull");
  assert.ok(model);
  assert.deepEqual(model!.symbols, ["BTC", "ETH"]);
  assert.equal(model!.returns[0].length, 365);
  assert.equal(model!.dates.length, 365);
  assert.equal(model!.excluded[0].symbol, "NEW");
  assert.ok(model!.stablecoinElasticity);
  assert.deepEqual(model!.defaultWeights, [0.4, 0.25]);
  const btc = panel.closes.BTC;
  assert.ok(Math.abs(model!.returns[0][364] - Math.log(btc[399]! / btc[398]!)) < 1e-6);
});
