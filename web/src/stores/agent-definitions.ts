import { create } from 'zustand';
import { api } from '../api/client';
import { getErrorMessage } from '../components/settings/types';

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  tools: string[];
  updatedAt: string;
}

export interface AgentDefinitionDetail extends AgentDefinition {
  content: string;
}

interface AgentDefinitionsState {
  agents: AgentDefinition[];
  loading: boolean;
  error: string | null;

  loadAgents: () => Promise<void>;
  getAgentDetail: (id: string) => Promise<AgentDefinitionDetail>;
  updateAgent: (id: string, content: string) => Promise<void>;
  createAgent: (name: string, content: string) => Promise<string>;
  deleteAgent: (id: string) => Promise<void>;
}

export const useAgentDefinitionsStore = create<AgentDefinitionsState>((set, get) => ({
  agents: [],
  loading: false,
  error: null,

  loadAgents: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ agents: AgentDefinition[] }>('/api/agent-definitions');
      set({ agents: data.agents, loading: false, error: null });
    } catch (err) {
      // ApiError 是 plain object（非 Error 实例），String(err) 会变 "[object Object]"，
      // 统一走 getErrorMessage 取后端 message（与 plugins store 同式）。
      set({ loading: false, error: getErrorMessage(err, '请求失败') });
    }
  },

  getAgentDetail: async (id: string) => {
    const data = await api.get<{ agent: AgentDefinitionDetail }>(`/api/agent-definitions/${id}`);
    return data.agent;
  },

  updateAgent: async (id: string, content: string) => {
    try {
      await api.put(`/api/agent-definitions/${id}`, { content });
      set({ error: null });
      await get().loadAgents();
    } catch (err) {
      set({ error: getErrorMessage(err, '请求失败') });
      throw err;
    }
  },

  createAgent: async (name: string, content: string) => {
    try {
      const data = await api.post<{ success: boolean; id: string }>('/api/agent-definitions', { name, content });
      set({ error: null });
      await get().loadAgents();
      return data.id;
    } catch (err) {
      set({ error: getErrorMessage(err, '请求失败') });
      throw err;
    }
  },

  deleteAgent: async (id: string) => {
    try {
      await api.delete(`/api/agent-definitions/${id}`);
      set({ error: null });
      await get().loadAgents();
    } catch (err) {
      set({ error: getErrorMessage(err, '请求失败') });
      throw err;
    }
  },
}));
