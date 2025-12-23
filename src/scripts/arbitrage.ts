import { DEFAULT_MIN_DIFF_PERCENT, getArbitrageOpportunities } from '../services/arbitrageService.js';

const parsedMinDiff = Number(process.env.MIN_DIFF_PERCENT ?? '');
const minDiffPercent = Number.isNaN(parsedMinDiff) ? undefined : parsedMinDiff;
const thresholdLabel = minDiffPercent ?? DEFAULT_MIN_DIFF_PERCENT;

async function run() {
  console.log(`Scanning spot pairs for >= ${thresholdLabel}% net diff (after fees)...`);
  const opportunities = await getArbitrageOpportunities(minDiffPercent);

  if (opportunities.length === 0) {
    console.log('No arbitrage opportunities found at this threshold.');
    return;
  }

  const table = opportunities.map((opportunity) => ({
    symbol: opportunity.symbol,
    netDiff: `${opportunity.netDiff.toFixed(2)}%`,
    grossDiff: `${opportunity.diff.toFixed(2)}%`,
    buy: `${opportunity.buy.exchange} @ ${opportunity.buy.price} (fee ${opportunity.buy.feePercentApplied}%)`,
    sell: `${opportunity.sell.exchange} @ ${opportunity.sell.price} (fee ${opportunity.sell.feePercentApplied}%)`
  }));

  console.table(table);
}

run().catch((error) => {
  console.error('Arbitrage scan failed', error);
  process.exit(1);
});
