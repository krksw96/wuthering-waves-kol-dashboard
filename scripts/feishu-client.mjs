const DEFAULT_BASE_URL = "https://open.feishu.cn";

export function createFeishuClient({
  appId,
  appSecret,
  spreadsheetToken,
  baseUrl = DEFAULT_BASE_URL,
  apiKey = "",
  fetchImpl = globalThis.fetch,
  retryAttempts = 3,
  retryDelayMs = 1_000,
} = {}) {
  if (!appId || !appSecret || !spreadsheetToken) {
    throw new Error("Feishu appId, appSecret, and spreadsheetToken are required.");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");

  let tenantToken = "";

  async function authenticate() {
    if (tenantToken) return tenantToken;
    const payload = await requestJson(
      "/open-apis/auth/v3/tenant_access_token/internal",
      {
        method: "POST",
        body: { app_id: appId, app_secret: appSecret },
        authenticated: false,
      },
    );
    tenantToken = String(payload.tenant_access_token || "");
    if (!tenantToken) throw new Error("Feishu authentication returned no tenant token.");
    return tenantToken;
  }

  async function requestJson(path, {
    method = "GET",
    body,
    authenticated = true,
  } = {}) {
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (apiKey) headers["X-API-Key"] = apiKey;
    if (authenticated) headers.Authorization = `Bearer ${await authenticate()}`;

    for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
      try {
        const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const payload = await parseJsonResponse(response);
        const code = Number(payload?.code ?? 0);
        if (response.ok && code === 0) return payload;

        const transient = response.status === 429 || response.status >= 500;
        if (!transient || attempt + 1 >= retryAttempts) {
          throw feishuError(response.status, code, payload?.msg || payload?.message);
        }
      } catch (error) {
        const isFeishuFailure = error?.name === "FeishuApiError";
        if (isFeishuFailure || attempt + 1 >= retryAttempts) throw error;
      }
      await delay(retryDelayMs * (2 ** attempt));
    }
    throw new Error("Feishu request failed after retries.");
  }

  async function readMatrix(range) {
    const encodedRange = encodeURIComponent(range);
    const payload = await requestJson(
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodedRange}`,
    );
    const values = payload?.data?.valueRange?.values;
    if (!Array.isArray(values)) throw new Error("Feishu values response did not contain a matrix.");
    return values;
  }

  async function insertRows(dimension, inheritStyle = "BEFORE") {
    return requestJson(
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/insert_dimension_range`,
      { method: "POST", body: { dimension, inheritStyle } },
    );
  }

  async function writeRange(range, values) {
    if (!Array.isArray(values) || !values.every(Array.isArray)) {
      throw new TypeError("Feishu values must be a two-dimensional array.");
    }
    return requestJson(
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values`,
      { method: "PUT", body: { valueRange: { range, values } } },
    );
  }

  async function deleteRows(dimension) {
    return requestJson(
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/dimension_range`,
      { method: "PUT", body: { dimension } },
    );
  }

  return {
    authenticate,
    readMatrix,
    insertRows,
    writeRange,
    deleteRows,
  };
}

async function parseJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error(`Feishu returned non-JSON HTTP ${response.status}.`);
    error.name = "FeishuApiError";
    throw error;
  }
}

function feishuError(status, code, message) {
  const error = new Error(`Feishu API failed: HTTP ${status}, code ${code}: ${String(message || "unknown error")}`);
  error.name = "FeishuApiError";
  return error;
}

function delay(milliseconds) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
