# GIWA Mini Launchpad

A small bonding-curve launchpad on GIWA Sepolia built with `@ammora-protocol/sdk@0.3.9` (Ammora V4, auto-route generation).

- **Launch:** issue a new token from an existing enabled Config (Config #1 has a 0 ETH creation fee). Calls `createLaunchWithTokenConfig` on the V4 factory; simulated with `eth_call` before the wallet prompt.
- **Browse:** recent `LaunchCreated` events from the factory, with curve status, graduation progress and WETH reserve read through `AmmoraV4LaunchCurveClient`.
- **Trade:** exact-input buy (ETH → WETH wrap → curve) and sell on the curve via `planSwapExactInput`, with slippage protection.

All signing happens in the visitor's injected wallet (OKX / MetaMask). No keys in this repo. Testnet only.

```sh
npm install
npm run dev      # local
npm run build    # static files in dist/
```
