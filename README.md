# Scout phone demo

Local fictional property demo. It is not a listing service, a loan approval, or a live search product.

The phone page ranks two fictional samples. The pictures are sample AI imagery, not real houses. The area note opens as Orlando, FL and is not sent. Dollar amounts come from the included sample calculator. Rank points are not dollars. Rent, insurance, and tax shown as sample assumptions are not a lease, a policy, or a tax bill. "3 bedrooms, 2 bathrooms" is an example description and is not used in the calculation.

Evidence text is a prepared sample labeled "AI-generated demo evidence — not verified." Opening the page, typing, and Find do not call a model.

## Run

This repository is the phone-only snapshot. It does not include the separate web app, its Vite config, market-snapshot builder, county index builder, or the broader test suite.

Node.js 22, from this folder:

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run phone
```

`npm run dev` and `npm start` start the same loopback phone server. `npm run lint` is the typecheck. `npm run clean` removes `dist/`.

`npm run build` writes a phone-only bundle to `dist/scout-serve.js` and `dist/scout-demo.js`. It does not call a provider. Open the source server with `npm run phone`, or the bundle with `node dist/scout-serve.js`. Both bind to 127.0.0.1:47221 unless you pass another port.

`npm test` builds that phone bundle, then runs an offline HTTP smoke test against the source server and the bundle. It checks the phone page, rank, detail, and provider-off responses. It does not use a network provider.

Open http://127.0.0.1:47221/phone on the same computer. The server binds to loopback only.

## Providers

Gemini, Google Search, and RentCast are off. This folder has no API key, no .env, and no spend record. A live model call needs a separate approval, a key that stays in the server environment, and SCOUT_RESEARCH_ARM=1. Do not add those for this demo.

Earlier paid Gemini and Google checks were separate tests. They are not in this folder.

## Publication

This tree is the v21 phone snapshot, added as new commits. It does not include private repository history. Do not import that history.

The two house pictures are generated sample images, not photographs of listed homes. Evidence copy is prepared analysis and is labeled AI-generated and unverified. Gemini and Google Search were tested separately and are not live in this demo. The live API arm stays off unless a key is set in the server environment and the separate arm flags are set. Do not add a key or those flags for this demo.
