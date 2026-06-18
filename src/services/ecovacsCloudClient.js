import { createHash } from "node:crypto";

const REALM = "ecouser.net";
const PATH_API_APPSVR_APP = "appsvr/app.do";
const PATH_API_USERS_USER = "users/user.do";

const CLIENT_KEY = "1520391301804";
const CLIENT_SECRET = "6c319b2a5cd3e66e39159c2e28f2fce9";
const AUTH_CLIENT_KEY = "1520391491841";
const AUTH_CLIENT_SECRET = "77ef58ce3afbe337da74aa8c5ab963a9";

const USER_LOGIN_PATH_FORMAT =
  "/v1/private/{country}/{lang}/{deviceId}/{appCode}/{appVersion}/{channel}/{deviceType}/user/login";
const GLOBAL_AUTHCODE_PATH = "/v1/global/auth/getAuthCode";

const META = {
  lang: "EN",
  appCode: "global_e",
  appVersion: "1.6.3",
  channel: "google_play",
  deviceType: "1"
};

const MAX_RETRIES = 3;
const LOGIN_SUCCESS_CODE = "0000";

function md5(value) {
  return createHash("md5").update(String(value)).digest("hex");
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getEcovacsCountry(alpha2Country) {
  if (alpha2Country === "GB") {
    return "UK";
  }

  return alpha2Country;
}

function getContinent(alpha2Country, explicitContinent) {
  if (explicitContinent) {
    return explicitContinent.toLowerCase();
  }

  const eu = new Set([
    "AT",
    "BE",
    "BG",
    "CH",
    "CY",
    "CZ",
    "DE",
    "DK",
    "EE",
    "ES",
    "FI",
    "FR",
    "GB",
    "GR",
    "HR",
    "HU",
    "IE",
    "IS",
    "IT",
    "LT",
    "LU",
    "LV",
    "MT",
    "NL",
    "NO",
    "PL",
    "PT",
    "RO",
    "SE",
    "SI",
    "SK",
    "UK"
  ]);
  const na = new Set(["CA", "MX", "US"]);
  const asia = new Set([
    "AE",
    "HK",
    "ID",
    "IL",
    "IN",
    "JP",
    "KR",
    "KW",
    "MY",
    "PH",
    "QA",
    "SA",
    "SG",
    "TH",
    "TR",
    "TW",
    "VN"
  ]);

  if (eu.has(alpha2Country)) {
    return "eu";
  }

  if (na.has(alpha2Country)) {
    return "na";
  }

  if (asia.has(alpha2Country)) {
    return "as";
  }

  return "ww";
}

function getContinentUrlPostfix(alpha2Country, explicitContinent) {
  if (alpha2Country === "CN") {
    return "";
  }

  return `-${getContinent(alpha2Country, explicitContinent)}`;
}

function createRestConfig({ deviceId, alpha2Country, explicitContinent, overrideRestUrl }) {
  const country = getEcovacsCountry(alpha2Country);

  if (overrideRestUrl) {
    return {
      country,
      deviceId,
      portalUrl: overrideRestUrl,
      loginUrl: overrideRestUrl,
      authCodeUrl: overrideRestUrl
    };
  }

  const continentPostfix = getContinentUrlPostfix(alpha2Country, explicitContinent);
  const portalUrl = `https://portal${continentPostfix}.ecouser.net`;
  const countryUrl = country.toLowerCase();
  const tld = alpha2Country === "CN" ? countryUrl : "com";

  return {
    country,
    deviceId,
    portalUrl,
    loginUrl: `https://gl-${countryUrl}-api.ecovacs.${tld}`,
    authCodeUrl: `https://gl-${countryUrl}-openapi.ecovacs.${tld}`
  };
}

function sign(params, additionalSignParams, key, secret) {
  const signData = {
    ...additionalSignParams,
    ...params
  };
  const signOnText =
    key +
    Object.keys(signData)
      .sort()
      .map((entryKey) => `${entryKey}=${String(signData[entryKey])}`)
      .join("") +
    secret;

  return {
    ...params,
    authSign: md5(signOnText),
    authAppkey: key
  };
}

function toQueryString(params) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    query.set(key, String(value));
  }

  return query.toString();
}

export class EcovacsCloudClient {
  constructor({ credentials, logger }) {
    this.inputCredentials = credentials;
    this.logger = logger;
    this.accountId = credentials.accountId || credentials.email;
    this.passwordHash = credentials.passwordHash || md5(credentials.password || "");
    this.restConfig = createRestConfig({
      deviceId: credentials.deviceId,
      alpha2Country: String(credentials.country || "").toUpperCase(),
      explicitContinent: credentials.continent,
      overrideRestUrl: credentials.overrideRestUrl
    });

    this.connected = false;
    this.sessionCredentials = null;
  }

  async connect() {
    if (!this.accountId || !this.passwordHash || !this.restConfig.deviceId) {
      throw new Error(
        "Missing required credentials. Expected accountId/email, password/passwordHash, and deviceId."
      );
    }

    await this.authenticate();

    this.connected = true;
  }

  async authenticate({ force = false } = {}) {
    if (
      !force &&
      this.sessionCredentials &&
      this.sessionCredentials.expiresAt > Math.floor(Date.now() / 1000)
    ) {
      return this.sessionCredentials;
    }

    this.logger.connection("Connecting to Ecovacs cloud", {
      accountId: this.accountId,
      country: this.restConfig.country,
      portalUrl: this.restConfig.portalUrl
    });

    const loginPasswordResponse = await this.callLoginApi();
    let userId = String(loginPasswordResponse.uid);

    const authCode = await this.callAuthApi(loginPasswordResponse.accessToken, userId);
    const loginTokenResponse = await this.callLoginByItToken(userId, authCode);

    if (String(loginTokenResponse.userId) !== userId) {
      userId = String(loginTokenResponse.userId);
    }

    const token = String(loginTokenResponse.token);
    const validitySeconds = Number(loginTokenResponse.last || 604800) / 1000;
    const expiresAt = Math.floor(Date.now() / 1000 + validitySeconds * 0.99);

    this.sessionCredentials = {
      token,
      userId,
      expiresAt
    };

    return this.sessionCredentials;
  }

  async doAuthResponse(url, params) {
    const query = toQueryString(params);
    const response = await fetch(`${url}?${query}`);

    if (!response.ok) {
      throw new Error(`Authentication request failed: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();

    if (String(payload.code) === LOGIN_SUCCESS_CODE) {
      return payload.data;
    }

    if (String(payload.code) === "1005" || String(payload.code) === "1010") {
      throw new Error("Invalid authentication. Check account and password.");
    }

    throw new Error(`Authentication failed: code=${payload.code}, msg=${payload.msg}`);
  }

  async callLoginApi() {
    const params = {
      account: this.accountId,
      password: this.passwordHash,
      requestId: md5(String(Date.now())),
      authTimespan: Date.now(),
      authTimeZone: "GMT-8"
    };

    const userLoginPath = USER_LOGIN_PATH_FORMAT.replace("{country}", this.restConfig.country.toLowerCase())
      .replace("{lang}", META.lang)
      .replace("{deviceId}", this.restConfig.deviceId)
      .replace("{appCode}", META.appCode)
      .replace("{appVersion}", META.appVersion)
      .replace("{channel}", META.channel)
      .replace("{deviceType}", META.deviceType);

    let url = new URL(userLoginPath, this.restConfig.loginUrl).toString();
    if (this.restConfig.country === "CN") {
      url += "CheckMobile";
    }

    return this.doAuthResponse(
      url,
      sign(
        params,
        {
          ...META,
          country: this.restConfig.country.toLowerCase(),
          deviceId: this.restConfig.deviceId
        },
        CLIENT_KEY,
        CLIENT_SECRET
      )
    );
  }

  async callAuthApi(accessToken, userId) {
    const params = {
      uid: userId,
      accessToken,
      bizType: "ECOVACS_IOT",
      deviceId: this.restConfig.deviceId,
      authTimespan: Date.now()
    };

    const url = new URL(GLOBAL_AUTHCODE_PATH, this.restConfig.authCodeUrl).toString();
    const response = await this.doAuthResponse(
      url,
      sign(params, { openId: "global" }, AUTH_CLIENT_KEY, AUTH_CLIENT_SECRET)
    );

    return String(response.authCode);
  }

  async post(path, body, { credentials = null, queryParams = null } = {}) {
    const requestBody = {
      ...body
    };

    if (credentials) {
      requestBody.auth = {
        with: "users",
        userid: credentials.userId,
        realm: REALM,
        token: credentials.token,
        resource: this.restConfig.deviceId
      };
    }

    let url = new URL(`api/${path}`, `${this.restConfig.portalUrl}/`).toString();

    if (queryParams) {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(queryParams)) {
        qs.set(key, String(value));
      }
      url += `?${qs.toString()}`;
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });

      if (response.ok) {
        return response.json();
      }

      if (response.status === 502 && attempt < MAX_RETRIES) {
        await delay(5000);
        continue;
      }

      throw new Error(`API request failed (${response.status}) on ${path}`);
    }

    throw new Error(`API request failed after retries on ${path}`);
  }

  async callLoginByItToken(userId, authCode) {
    const data = {
      edition: "ECOGLOBLE",
      userId,
      token: authCode,
      realm: REALM,
      resource: this.restConfig.deviceId,
      org: this.restConfig.country !== "CN" ? "ECOWW" : "ECOCN",
      last: "",
      country: this.restConfig.country !== "CN" ? this.restConfig.country : "Chinese",
      todo: "loginByItToken"
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await this.post(PATH_API_USERS_USER, data);
      if (response.result === "ok") {
        return response;
      }

      if (
        response.result === "fail" &&
        response.error === "set token error." &&
        attempt < 3
      ) {
        this.logger.warn("loginByItToken set token error, retrying", { attempt: attempt + 1 });
        continue;
      }

      throw new Error(
        `loginByItToken failed: ${response.error || "unknown error"} (${response.errno || "n/a"})`
      );
    }

    throw new Error("Failed to login with token");
  }

  async postAuthenticated(path, body, { queryParams = null } = {}) {
    const sessionCredentials = await this.authenticate();
    return this.post(path, body, { credentials: sessionCredentials, queryParams });
  }

  async getDevices() {
    if (!this.connected) {
      throw new Error("Cloud client is not connected");
    }

    const credentials = await this.authenticate();

    const [deviceListResponse, globalDeviceListResponse] = await Promise.all([
      this.postAuthenticated(PATH_API_USERS_USER, {
        userid: credentials.userId,
        todo: "GetDeviceList"
      }),
      this.postAuthenticated(PATH_API_APPSVR_APP, {
        userid: credentials.userId,
        todo: "GetGlobalDeviceList"
      })
    ]);

    const devicesByDid = new Map();
    for (const device of deviceListResponse.devices || []) {
      devicesByDid.set(device.did, device);
    }

    for (const device of globalDeviceListResponse.devices || []) {
      devicesByDid.set(device.did, device);
    }

    const allDevices = Array.from(devicesByDid.values());
    const mqtt = [];
    const xmpp = [];
    const notSupported = [];

    for (const device of allDevices) {
      if (device.company === "eco-ng") {
        mqtt.push(device);
      } else if (device.company === "eco-legacy") {
        xmpp.push(device);
      } else {
        notSupported.push(device);
      }
    }

    this.logger.info("Fetched devices", {
      all: allDevices.length,
      mqtt: mqtt.length,
      xmpp: xmpp.length,
      notSupported: notSupported.length
    });

    return {
      all: allDevices,
      mqtt,
      xmpp,
      notSupported
    };
  }

  async getSessionCredentials() {
    return this.authenticate();
  }
}
