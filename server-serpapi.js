// ══════════════════════════════════════════════
// جوّك — SerpApi Google Flights Search Server
// بحث فقط — لا يوجد حجز عبر SerpApi.
// ══════════════════════════════════════════════
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import 'dotenv/config';

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY || '';
const SERVICE_SECRET = process.env.SERPAPI_SERVICE_SECRET || '';
const MAIN_SERVER_URL = process.env.MAIN_SERVER_URL || '';
const SERPAPI_BASE = 'https://serpapi.com/search.json';

const REQUEST_TIMEOUT_MS = 20_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 30;
const MAX_ROUNDTRIP_OUTBOUND = 8;
const MAX_RETURN_OPTIONS_PER_OUTBOUND = 3;
const rateBuckets = new Map();

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (!MAIN_SERVER_URL) return callback(null, true);

    const allowed = MAIN_SERVER_URL
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);

    return callback(null, allowed.includes(origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-SerpApi-Service-Secret'],
}));

app.use(express.json({ limit: '50kb' }));

function getClientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.ip || 'unknown')
    .split(',')[0]
    .trim();
}

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = getClientIp(req);
  let bucket = rateBuckets.get(key);

  if (!bucket || now - bucket.startedAt >= RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(key, bucket);
  }

  bucket.count += 1;

  if (bucket.count > RATE_MAX_REQUESTS) {
    const retryAfter = Math.ceil(
      (RATE_WINDOW_MS - (now - bucket.startedAt)) / 1000
    );

    res.set('Retry-After', String(retryAfter));

    return res.status(429).json({
      error: 'طلبات كثيرة خلال وقت قصير. حاول مرة أخرى بعد قليل.'
    });
  }

  if (rateBuckets.size > 5000) {
    for (const [ip, item] of rateBuckets) {
      if (now - item.startedAt >= RATE_WINDOW_MS) {
        rateBuckets.delete(ip);
      }
    }
  }

  next();
}

function requireServiceSecret(req, res, next) {
  if (!SERVICE_SECRET) return next();

  const received = String(
    req.headers['x-serpapi-service-secret'] || ''
  );

  if (!received || received !== SERVICE_SECRET) {
    return res.status(401).json({
      error: 'غير مصرح لهذا الطلب.'
    });
  }

  next();
}

function validateSearchBody(body = {}) {
  const from = String(body.from || '').trim().toUpperCase();
  const to = String(body.to || '').trim().toUpperCase();
  const departDate = String(body.departDate || '').trim();
  const returnDate = body.returnDate
    ? String(body.returnDate).trim()
    : '';

  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    return { error: 'بيانات المطارات غير صالحة.' };
  }

  if (from === to) {
    return { error: 'مدينة المغادرة والوصول يجب أن تكونا مختلفتين.' };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(departDate)) {
    return { error: 'تاريخ السفر غير صالح.' };
  }

  if (returnDate && !/^\d{4}-\d{2}-\d{2}$/.test(returnDate)) {
    return { error: 'تاريخ العودة غير صالح.' };
  }

  const adults = Number(body.adults);
  const children = Number(body.children || 0);
  const infants = Number(body.infants || 0);
  const cabin = String(body.cabin || 'economy').toLowerCase();

  if (!Number.isInteger(adults) || adults < 1 || adults > 9) {
    return { error: 'عدد البالغين غير صالح.' };
  }

  if (!Number.isInteger(children) || children < 0 || children > 8) {
    return { error: 'عدد الأطفال غير صالح.' };
  }

  if (
    !Number.isInteger(infants) ||
    infants < 0 ||
    infants > 9 ||
    infants > adults
  ) {
    return { error: 'عدد الرضع غير صالح.' };
  }

  if (!new Set(['economy', 'premium_economy', 'business', 'first']).has(cabin)) {
    return { error: 'درجة السفر غير صالحة.' };
  }

  if (returnDate) {
    const dep = new Date(`${departDate}T00:00:00Z`);
    const ret = new Date(`${returnDate}T00:00:00Z`);
    if (Number.isNaN(dep.getTime()) || Number.isNaN(ret.getTime())) {
      return { error: 'تاريخ السفر غير صالح.' };
    }
    if (ret < dep) {
      return { error: 'تاريخ العودة يجب أن يكون بعد أو مساويًا لتاريخ الذهاب.' };
    }
  }

  return {
    value: {
      from,
      to,
      departDate,
      returnDate,
      adults,
      children,
      infants,
      cabin,
    }
  };
}

function cabinToSerpApi(cabin) {
  return {
    economy: '1',
    premium_economy: '2',
    business: '3',
    first: '4',
  }[cabin] || '1';
}

function makeId(value) {
  return crypto
    .createHash('sha1')
    .update(String(value))
    .digest('hex')
    .slice(0, 20);
}

function parseDateTime(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  return {
    date: match?.[1] || '',
    time: match?.[2] || '',
  };
}

function buildLeg(segments) {
  if (!Array.isArray(segments) || !segments.length) return null;

  const first = segments[0];
  const last = segments[segments.length - 1];
  const dep = parseDateTime(first?.departure_airport?.time);
  const arr = parseDateTime(last?.arrival_airport?.time);
  const airlineCode = airlineCodeFromSegment(first);
  const flightNumber = String(first?.flight_number || '').trim();

  const durationMinutes = segments.reduce(
    (sum, segment) => sum + Number(segment?.duration || 0),
    0
  );

  return {
    from: first?.departure_airport?.id || '',
    to: last?.arrival_airport?.id || '',
    depTime: dep.time,
    arrTime: arr.time,
    depDate: dep.date,
    arrDate: arr.date,
    durationMinutes,
    stops: Math.max(0, segments.length - 1),
    flightNumber,
    airlineCode,
    airlineName: first?.airline || 'شركة طيران',
    airlineLogo: first?.airline_logo || '',
  };
}

function airlineCodeFromSegment(segment) {
  const logo = String(segment?.airline_logo || '');
  const logoMatch = logo.match(/\/([A-Z0-9]{2})\.png(?:\?|$)/i);
  if (logoMatch?.[1]) return logoMatch[1].toUpperCase();

  const flightNumber = String(segment?.flight_number || '').trim();
  const numberMatch = flightNumber.match(/^([A-Z0-9]{2})\s*\d/i);
  return numberMatch?.[1]?.toUpperCase() || '';
}

function normalizeItinerary(itinerary, outboundDate, inboundDate) {
  const price = Number(itinerary?.price);
  if (!Number.isFinite(price) || price < 0) return null;

  const segments = Array.isArray(itinerary?.flights)
    ? itinerary.flights
    : [];

  if (!segments.length) return null;

  let splitIndex = -1;

  if (inboundDate) {
    splitIndex = segments.findIndex(segment => {
      const dep = parseDateTime(segment?.departure_airport?.time);
      return dep.date === inboundDate;
    });

    if (splitIndex <= 0) {
      splitIndex = segments.findIndex(segment => {
        const dep = parseDateTime(segment?.departure_airport?.time);
        return dep.date > outboundDate;
      });
    }
  }

  const outboundSegments = splitIndex > 0
    ? segments.slice(0, splitIndex)
    : segments;

  const returnSegments = splitIndex > 0
    ? segments.slice(splitIndex)
    : [];

  const outbound = buildLeg(outboundSegments);
  const inbound = returnSegments.length
    ? buildLeg(returnSegments)
    : null;

  if (!outbound) return null;

  const key = [
    outbound.airlineCode,
    outbound.flightNumber,
    outbound.from,
    outbound.to,
    outbound.depDate,
    outbound.depTime,
    outbound.arrTime,
    inbound?.flightNumber || '',
    inbound?.from || '',
    inbound?.to || '',
    inbound?.depDate || '',
    inbound?.depTime || '',
    inbound?.arrTime || '',
  ].join('|');

  return {
    id: `serp_${makeId(key)}`,
    source: 'serpapi',
    airlineCode: outbound.airlineCode,
    airlineName: outbound.airlineName,
    airlineLogo: outbound.airlineLogo,
    flightNumber: outbound.flightNumber,
    from: outbound.from,
    to: outbound.to,
    depTime: outbound.depTime,
    arrTime: outbound.arrTime,
    durationMinutes: outbound.durationMinutes,
    stops: outbound.stops,
    returnLeg: inbound
      ? {
          from: inbound.from,
          to: inbound.to,
          depTime: inbound.depTime,
          arrTime: inbound.arrTime,
          durationMinutes: inbound.durationMinutes,
          stops: inbound.stops,
          flightNumber: inbound.flightNumber,
        }
      : null,
    price,
    currency: 'EGP',
    originalPrice: Math.round(price),
    originalCurrency: 'EGP',
    seatsLeft: null,
    cabin: null,
    baggage: null,
    refundable: null,
    refundPenalty: null,
    refundPenaltyCurrency: null,
    bookingToken: itinerary?.booking_token || null,
  };
}

function buildBaseParams(search) {
  const params = new URLSearchParams({
    engine: 'google_flights',
    api_key: SERPAPI_API_KEY,
    departure_id: search.from,
    arrival_id: search.to,
    outbound_date: search.departDate,
    type: search.returnDate ? '1' : '2',
    adults: String(search.adults),
    children: String(search.children),
    infants_on_lap: String(search.infants),
    travel_class: cabinToSerpApi(search.cabin),
    currency: 'EGP',
    gl: 'eg',
    hl: 'en',
    sort_by: '2',
    deep_search: 'false',
  });

  if (search.returnDate) {
    params.set('return_date', search.returnDate);
  }

  return params;
}

async function fetchSerpApi(params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${SERPAPI_BASE}?${params.toString()}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }
    );

    const data = await response.json().catch(() => null);

    if (!response.ok || data?.error) {
      throw new Error(
        data?.error || `SerpApi returned HTTP ${response.status}`
      );
    }

    return data || {};
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('انتهت مهلة الاتصال بـSerpApi.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function getItineraries(data) {
  return [
    ...(Array.isArray(data?.best_flights) ? data.best_flights : []),
    ...(Array.isArray(data?.other_flights) ? data.other_flights : []),
  ];
}

async function searchOneWay(search) {
  const data = await fetchSerpApi(buildBaseParams(search));
  const currency = data?.search_parameters?.currency || 'EGP';

  return getItineraries(data)
    .map(item => normalizeItinerary(item, search.departDate, null))
    .filter(Boolean)
    .map(item => ({ ...item, currency, originalCurrency: currency }));
}

async function searchRoundTrip(search) {
  // SerpApi يعيد الرحلات الخارجة أولاً، ثم نستخدم departure_token
  // لكل رحلة للحصول على خيارات العودة المرتبطة بها.
  const firstData = await fetchSerpApi(buildBaseParams(search));
  const outboundOptions = getItineraries(firstData)
    .filter(item => item?.departure_token)
    .slice(0, MAX_ROUNDTRIP_OUTBOUND);

  const currency = firstData?.search_parameters?.currency || 'EGP';

  const groups = await Promise.all(
    outboundOptions.map(async outbound => {
      try {
        const params = buildBaseParams(search);
        params.set('departure_token', String(outbound.departure_token));

        const returnData = await fetchSerpApi(params);
        const returnOptions = getItineraries(returnData)
          .slice(0, MAX_RETURN_OPTIONS_PER_OUTBOUND);

        return returnOptions
          .map(item => normalizeItinerary(item, search.departDate, search.returnDate))
          .filter(Boolean);
      } catch (err) {
        console.error('SerpApi return search failed:', err?.message || err);
        return [];
      }
    })
  );

  return groups
    .flat()
    .map(item => ({ ...item, currency, originalCurrency: currency }));
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'jawwak-serpapi-google-flights',
    serpapiConfigured: Boolean(SERPAPI_API_KEY),
  });
});

app.post(
  '/api/search-flights',
  rateLimit,
  requireServiceSecret,
  async (req, res) => {
    try {
      if (!SERPAPI_API_KEY) {
        return res.status(503).json({
          error: 'خدمة SerpApi غير مهيأة حالياً.'
        });
      }

      const validation = validateSearchBody(req.body);
      if (validation.error) {
        return res.status(400).json({ error: validation.error });
      }

      const search = validation.value;
      const flights = search.returnDate
        ? await searchRoundTrip(search)
        : await searchOneWay(search);

      return res.json({
        flights,
        count: flights.length,
        currency: 'EGP',
      });
    } catch (err) {
      console.error('SerpApi service error:', err);

      return res.status(500).json({
        error:
          err?.message ||
          'تعذر إكمال بحث Google Flights حالياً.'
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(`Jawwak SerpApi server running on port ${PORT}`);
});
