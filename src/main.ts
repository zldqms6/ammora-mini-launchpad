import "./style.css";
import {
  AmmoraV4LaunchCurveClient,
  ammoraLaunchFactoryV4Abi,
  buildCreateAmmoraV4Launch,
  classifyAmmoraV4ExactInputFill,
  getAmmoraV4ConfigAtBlock,
  giwaSepoliaAutoRouteDeployment,
} from "@ammora-protocol/sdk";
import {
  createPublicClient, createWalletClient, custom, defineChain, encodeFunctionData, erc20Abi, formatEther, formatUnits,
  http, parseAbi, parseEther, parseEventLogs, parseUnits,
  type Address, type EIP1193Provider, type Hex, type PublicClient, type Transport, type WalletClient,
} from "viem";

// GIWA Sepolia, Ammora V4 "auto-route" generation (the default path of the official launchpad guide).
const deployment = giwaSepoliaAutoRouteDeployment;
const launch = deployment.contracts.launch;
const RPC = deployment.chain.rpcUrls[0]!;
const chain = defineChain({
  id: deployment.chain.id,
  name: deployment.chain.name,
  nativeCurrency: deployment.chain.nativeCurrency,
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: "GIWA Explorer", url: "https://sepolia-explorer.giwa.io" } },
});
const core = { launchFactory: launch.factory as Address, feePolicy: launch.feePolicy as Address };
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const wethAbi = parseAbi(["function deposit() payable"]);
const STATUS = ["Uninitialized", "Active", "ReadyToMigrate", "Migrated"];
const LOG_SPAN = 10_000n; // public RPC caps eth_getLogs at 10k blocks
const LOG_CHUNKS = 5;

// The public GIWA RPC rate-limits per JSON-RPC call (429), and SDK reads fan out with Promise.all.
// Serialize calls with a small gap, as the official examples do (pacedHttp).
const pacedHttp = (url: string, intervalMs = 250): Transport => {
  let tail: Promise<unknown> = Promise.resolve();
  let nextStart = 0;
  return (parameters) => {
    const base = http(url, { retryCount: 2, retryDelay: 1500 })(parameters);
    return custom({
      request: (args) => {
        const result = tail.then(async () => {
          await new Promise((r) => setTimeout(r, Math.max(0, nextStart - Date.now())));
          try { return await base.request(args); } finally { nextStart = Date.now() + intervalMs; }
        });
        tail = result.catch(() => undefined);
        return result;
      },
    }, { retryCount: 0 })(parameters);
  };
};
const client = createPublicClient({ chain, transport: pacedHttp(RPC) }) as PublicClient;
let wallet: WalletClient | null = null;
let account: Address | null = null;
let selected: { token: Address; curve: Address; symbol: string; decimals: number } | null = null;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const val = (id: string) => $<HTMLInputElement>(id).value.trim();
const out = (id: string, text: string) => { $(id).textContent = text; };
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const explorer = (path: string) => `${chain.blockExplorers!.default.url}/${path}`;
const errText = (e: unknown) => (e as { shortMessage?: string; message?: string })?.shortMessage
  ?? (e as Error)?.message ?? String(e);

async function connect() {
  const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!eth) { alert("No injected wallet found (install OKX Wallet or MetaMask)."); return; }
  const [addr] = await eth.request({ method: "eth_requestAccounts" }) as Address[];
  const hexId = `0x${chain.id.toString(16)}`;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch {
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: hexId, chainName: chain.name, nativeCurrency: chain.nativeCurrency,
        rpcUrls: [RPC], blockExplorerUrls: [chain.blockExplorers!.default.url] }],
    });
  }
  account = addr!;
  wallet = createWalletClient({ account, chain, transport: custom(eth) });
  const bal = await client.getBalance({ address: account });
  out("account", `${short(account)} · ${Number(formatEther(bal)).toFixed(4)} ETH`);
}

async function send(to: Address, data: Hex, value = 0n): Promise<Hex> {
  if (!wallet || !account) throw new Error("Connect your wallet first");
  // Simulate first so a bad input never reaches the wallet prompt.
  await client.call({ account, to, data, value });
  const hash = await wallet.sendTransaction({ account, chain, to, data, value });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`Reverted: ${hash}`);
  return hash;
}

// ---------- Launch ----------
async function readConfig() {
  const id = BigInt(val("cfg") || "0");
  const block = await client.getBlockNumber();
  const entry = await getAmmoraV4ConfigAtBlock(client, launch.configRegistry as Address, id, block);
  return { id, entry };
}

async function checkConfig() {
  out("launchOut", "Reading config…");
  try {
    const { id, entry } = await readConfig();
    out("launchOut", [
      `Config #${id}: ${entry.enabled ? "enabled" : "DISABLED"}`,
      `quote token ${entry.config.quoteToken} · token decimals ${entry.config.tokenDecimals}`,
      `creation fee ${formatEther(entry.config.poolCreationFee)} ETH · segments ${entry.segments.length}`,
      `owner ${entry.identity.owner}`,
    ].join("\n"));
  } catch (e) { out("launchOut", `Error: ${errText(e)}`); }
}

async function createLaunch() {
  const name = val("name"), symbol = val("symbol"), meta = val("meta");
  if (!name || !symbol || !meta) { out("launchOut", "Name, symbol and metadata URI are required."); return; }
  try {
    const { id, entry } = await readConfig();
    if (!entry.enabled) throw new Error(`Config #${id} is disabled`);
    const tx = buildCreateAmmoraV4Launch(
      { name, symbol, metadataURI: meta, creatorMetadataURI: meta, tokenDecimals: entry.config.tokenDecimals },
      id, entry.config.poolCreationFee,
    );
    out("launchOut", "Confirm in your wallet…");
    const hash = await send(launch.factory as Address, tx.data, tx.value);
    out("launchOut", `Launched! tx ${hash}\n${explorer(`tx/${hash}`)}`);
    await loadLaunches();
  } catch (e) { out("launchOut", `Error: ${errText(e)}`); }
}

// ---------- Recent launches ----------
async function loadLaunches() {
  const body = $("launches");
  body.innerHTML = `<tr><td colspan="6">Loading…</td></tr>`;
  try {
    const head = await client.getBlockNumber();
    const found: { token: Address; curve: Address; configId: bigint }[] = [];
    for (let i = 0; i < LOG_CHUNKS && found.length < 10; i++) {
      const toBlock = head - BigInt(i) * LOG_SPAN;
      const logs = await client.getLogs({ address: launch.factory as Address, fromBlock: toBlock - LOG_SPAN + 1n, toBlock });
      const created = parseEventLogs({ abi: ammoraLaunchFactoryV4Abi, logs, eventName: "LaunchCreated" });
      for (const l of created.reverse()) found.push({ token: l.args.token, curve: l.args.curve, configId: l.args.configId });
    }
    if (!found.length) { body.innerHTML = `<tr><td colspan="6">No launches in range.</td></tr>`; return; }
    body.innerHTML = "";
    for (const f of found.slice(0, 10)) {
      const row = document.createElement("tr");
      body.appendChild(row);
      try {
        const sdk = new AmmoraV4LaunchCurveClient(client, f.curve, core);
        const [state, symbol, decimals] = await Promise.all([
          sdk.getState(),
          client.readContract({ address: f.token, abi: erc20Abi, functionName: "symbol" }),
          client.readContract({ address: f.token, abi: erc20Abi, functionName: "decimals" }),
        ]);
        const pct = state.migrationQuoteThreshold > 0n
          ? Number(state.quoteReserve * 10_000n / state.migrationQuoteThreshold) / 100 : 0;
        row.innerHTML = `<td><a href="${explorer(`token/${f.token}`)}" target="_blank">${symbol}</a></td>
          <td>#${f.configId}</td><td>${STATUS[state.status] ?? state.status}</td><td>${pct.toFixed(2)}%</td>
          <td>${Number(formatEther(state.quoteReserve)).toFixed(4)}</td><td></td>`;
        if (state.status === 1) {
          const b = document.createElement("button");
          b.textContent = "Trade";
          b.onclick = () => selectLaunch({ token: f.token, curve: f.curve, symbol, decimals });
          row.lastElementChild!.appendChild(b);
        }
      } catch (e) {
        row.innerHTML = `<td>${short(f.token)}</td><td>#${f.configId}</td><td colspan="4">unreadable: ${errText(e).slice(0, 80)}</td>`;
      }
    }
  } catch (e) { body.innerHTML = `<tr><td colspan="6">Error: ${errText(e)}</td></tr>`; }
}

function selectLaunch(l: NonNullable<typeof selected>) {
  selected = l;
  $("trade").hidden = false;
  out("tradeTitle", `· ${l.symbol}`);
  out("tradeOut", "");
  $("trade").scrollIntoView({ behavior: "smooth" });
}

// ---------- Trade ----------
function tradeInput() {
  if (!selected) throw new Error("Pick a launch first");
  const buy = $<HTMLSelectElement>("side").value === "buy";
  const amountIn = buy ? parseEther(val("amount")) : parseUnits(val("amount"), selected.decimals);
  if (amountIn <= 0n) throw new Error("Amount must be positive");
  return { buy, amountIn, sdk: new AmmoraV4LaunchCurveClient(client, selected.curve, core) };
}

async function quote() {
  try {
    const { buy, amountIn, sdk } = tradeInput();
    const q = await sdk.quoteExactInput(amountIn, !buy);
    const fill = classifyAmmoraV4ExactInputFill(q, !buy);
    const outText = buy ? `${formatUnits(q.amountOut, selected!.decimals)} ${selected!.symbol}` : `${formatEther(q.amountOut)} WETH`;
    out("tradeOut", `You receive ≈ ${outText}\nfee ${buy ? formatEther(q.fee) : formatUnits(q.fee, selected!.decimals)} · fill ${fill.kind}`);
  } catch (e) { out("tradeOut", `Error: ${errText(e)}`); }
}

async function swap() {
  try {
    if (!account) throw new Error("Connect your wallet first");
    const { buy, amountIn, sdk } = tradeInput();
    const q = await sdk.quoteExactInput(amountIn, !buy);
    const fill = classifyAmmoraV4ExactInputFill(q, !buy);
    if (fill.kind === "partial") throw new Error("This order would only partially fill; reduce the amount.");
    const plan = await sdk.planSwapExactInput({
      includedAmountIn: amountIn, baseForQuote: !buy, allowPartialFill: fill.allowPartialFill,
      slippageBps: Number(val("slip") || "100"), recipient: account,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    });
    const tokenIn = buy ? WETH : selected!.token;
    if (buy) {
      // The curve trades WETH; wrap only the shortfall.
      const wethBal = await client.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [account] });
      if (wethBal < amountIn) {
        out("tradeOut", "Step 1/3: wrap ETH → WETH (confirm in wallet)…");
        await send(WETH, encodeFunctionData({ abi: wethAbi, functionName: "deposit" }), amountIn - wethBal);
      }
    }
    const allowance = await client.readContract({ address: tokenIn, abi: erc20Abi, functionName: "allowance", args: [account, selected!.curve] });
    if (allowance < amountIn) {
      out("tradeOut", "Approve the curve to spend your input (confirm in wallet)…");
      await send(tokenIn, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [selected!.curve, amountIn] }));
    }
    out("tradeOut", "Swap (confirm in wallet)…");
    const hash = await send(plan.transaction.to as Address, plan.transaction.data as Hex, plan.transaction.value ?? 0n);
    out("tradeOut", `Swapped. min out ${plan.quote.minimumAmountOut}\n${explorer(`tx/${hash}`)}`);
    await loadLaunches();
  } catch (e) { out("tradeOut", `Error: ${errText(e)}`); }
}


$("connect").onclick = () => connect().catch((e) => alert(errText(e)));
$("checkCfg").onclick = checkConfig;
$("launch").onclick = createLaunch;
$("refresh").onclick = loadLaunches;
$("quote").onclick = quote;
$("swap").onclick = swap;
loadLaunches();
