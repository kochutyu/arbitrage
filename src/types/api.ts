export interface ApiResponse<T> {
  data: T;
  source: string;
}

export interface HealthResponse {
  status: 'ok';
  timestamp: string;
}

export interface ErrorResponse {
  error: string;
  details?: string;
}

export type ExchangesResponse = string[];
