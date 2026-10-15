const axios = require('axios');

const BASE = 'https://api.higgsfield.ai';
const MODEL = 'higgsfield/genjutsu/motion-transfer/v1.0';

function headers(credential) {
  if (!credential || /[\r\n]/.test(credential)) throw new Error('Chave Higgsfield inválida.');
  return { Authorization: `Key ${credential}` };
}

function apiError(error) {
  const status = error.response?.status;
  const detail = error.response?.data?.message || error.response?.data?.error;
  return new Error(status ? `Higgsfield respondeu ${status}${detail ? `: ${String(detail).slice(0, 250)}` : ''}` : `Higgsfield indisponível: ${error.message}`);
}

async function submit(credential, input) {
  try {
    const response = await axios.post(`${BASE}/${MODEL}`, input, {
      headers: { ...headers(credential), 'Content-Type': 'application/json' }, timeout: 30000
    });
    if (!response.data?.request_id) throw new Error('Higgsfield não retornou request_id.');
    return response.data;
  } catch (error) { throw apiError(error); }
}

async function status(credential, requestId) {
  try {
    const response = await axios.get(`${BASE}/requests/${encodeURIComponent(requestId)}/status`, {
      headers: headers(credential), timeout: 15000
    });
    return response.data;
  } catch (error) { throw apiError(error); }
}

async function cancel(credential, requestId) {
  try {
    const response = await axios.post(`${BASE}/requests/${encodeURIComponent(requestId)}/cancel`, {}, {
      headers: headers(credential), timeout: 15000
    });
    return response.data;
  } catch (error) { throw apiError(error); }
}

module.exports = { submit, status, cancel };
