import { mutator as roomMutator, type Mutator, type Op } from "../mutate.ts";
import { useQuery, type Fetcher } from "../store.ts";
import { fetched } from "../api.ts";

export interface AgentToken { id: string; name: string; scopes: string; created_at: number; last_used_at: number | null }
export interface AgentTokens { tokens: AgentToken[]; mcpPath: string }

export const AGENT_TOKENS = "agent-tokens";
const tokensRead: Fetcher<AgentTokens> = () => fetched<AgentTokens>("/api/agent/tokens");
export const useAgentTokens = (): AgentTokens | undefined => useQuery<AgentTokens>(AGENT_TOKENS, tokensRead, { tags: [AGENT_TOKENS] });

export const agentOps = {
  create(name: string, write: boolean): Op<AgentTokens & { id: string; token: string }> {
    return { label: "make an agent token", lanes: [AGENT_TOKENS], method: "POST", path: "/api/agent/tokens", body: { name, write }, invalidates: [AGENT_TOKENS] };
  },
  revoke(id: string): Op<AgentTokens> {
    return { label: "revoke that agent token", lanes: [AGENT_TOKENS], method: "DELETE", path: `/api/agent/tokens/${encodeURIComponent(id)}`, invalidates: [AGENT_TOKENS] };
  },
};

export const agents = {
  create: (name: string, write: boolean, m: Mutator = roomMutator) => m.release(agentOps.create(name, write)),
  revoke: (id: string, m: Mutator = roomMutator) => m.release(agentOps.revoke(id)),
};
