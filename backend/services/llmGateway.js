import OpenAI from 'openai';
import env from '../config/environment.js';

let client = null;

// Created lazily so the server still boots if the key isn't set yet.
export const getGatewayClient = () => {
  if (!env.gateway.apiKey) {
    throw new Error('EXPLABS_API_KEY is not set. Add it to backend/.env');
  }
  if (!client) {
    client = new OpenAI({
      baseURL: env.gateway.baseUrl,
      apiKey: env.gateway.apiKey,
    });
  }
  return client;
};

// Minimal body on purpose: model + messages only, no sampling params.
export const chat = async (model, userMessage) => {
  const gateway = getGatewayClient();
  return gateway.chat.completions.create({
    model,
    messages: [{ role: 'user', content: userMessage }],
  });
};