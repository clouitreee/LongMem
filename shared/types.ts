export interface ObserveRequest {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output: string;
  prompt_number?: number;
}

export interface PromptRequest {
  session_id: string;
  text: string;
}

export interface SessionStartRequest {
  session_id: string;
  project: string;
  directory: string;
}

export interface SessionEndRequest {
  session_id: string;
}

export interface SearchResponse {
  results: CompactObservation[];
  total: number;
}

export interface CompactObservation {
  id: number;
  date: string;
  tool: string;
  summary: string;
  files: string | null;
  rank: number;
}

export interface ObservationResponse {
  observations: FullObservation[];
}

export interface FullObservation {
  id: number;
  session_id: number;
  tool_name: string;
  tool_input: string;
  tool_output: string;
  compressed_summary: string | null;
  observation_type: string | null;
  files_referenced: string | null;
  concepts: string | null;
  created_at: string;
}

export interface TimelineResponse {
  before: CompactObservation[];
  target: FullObservation | null;
  after: CompactObservation[];
}

export interface HealthResponse {
  status: string;
  uptime: number;
  pending: number;
}
