import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { getArbitrageOpportunities } from './services/arbitrageService.js';
import type { ErrorResponse, HealthResponse } from './types/api.js';
import type { ArbitrageOpportunity } from './types/exchange.js';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(express.json());
app.use(
  cors({
    origin: '*'
  })
);

app.get('/health', (_req: Request, res: Response<HealthResponse>) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get(
  '/api/arbitrage',
  async (
    req: Request,
    res: Response<ArbitrageOpportunity[] | ErrorResponse>,
    next: NextFunction
  ) => {
    const minDiffParam = req.query.minDiffPercent;
    const minDiffPercent =
      minDiffParam === undefined ? undefined : Number(Array.isArray(minDiffParam) ? minDiffParam[0] : minDiffParam);

    if (minDiffPercent !== undefined && Number.isNaN(minDiffPercent)) {
      res.status(400).json({ error: 'minDiffPercent must be a number' });
      return;
    }

    try {
      const opportunities = await getArbitrageOpportunities(minDiffPercent);
      res.json(opportunities);
    } catch (error) {
      next(error);
    }
  }
);

// Basic error middleware keeps error formatting consistent
app.use((error: unknown, _req: Request, res: Response<ErrorResponse>, _next: NextFunction) => {
  console.error(error);
  const message = error instanceof Error ? error.message : 'Unexpected error';
  res.status(500).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

export default app;
