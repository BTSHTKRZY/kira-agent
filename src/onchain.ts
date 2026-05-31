import {
  createWalletClient,
  createPublicClient,
  http,
  parseEther,
  formatEther,
  getAddress,
} from "viem";
import { base, mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const AGENTCHECK_URL    = process.env.AGENTCHECK_URL || "https://agentcheck-bice.vercel.app";
const HOLDER_WALLET     = process.env.HOLDER_WALLET  || "";
const AUTO_SWEEP_ETH    = parseFloat(process.env.AUTO_SWEEP_THRESHOLD_ETH || "0.1");
const MIN_BALANCE_ETH   = parseFloat(process.env.MIN_OPERATING_BALANCE_ETH || "0.02");

export class KiraOnchain {
  private walletClient:  any;
  private publicClient:  any;
  private ethClient:     any;
  private account:       any;
  private wallet:        string;
  private initialized:   boolean = false;

  constructor() {
    this.wallet = process.env.KIRA_WALLET || "";
  }

  async init(): Promise<boolean> {
    try {
      const privateKey = process.env.KIRA_PRIVATE_KEY;
      if (!privateKey) {
        console.log("No private key — on-chain write operations disabled");
        // Still set up read client
        this.publicClient = createPublicClient({
          chain:     base,
          transport: http(process.env.BASE_RPC || "https://mainnet.base.org"),
        });
        this.ethClient = createPublicClient({
          chain:     mainnet,
          transport: http(process.env.ETH_RPC || "https://eth.llamarpc.com"),
        });
        return true;
      }

      const key = privateKey.startsWith("0x")
        ? privateKey as `0x${string}`
        : `0x${privateKey}` as `0x${string}`;

      this.account = privateKeyToAccount(key);

      this.walletClient = createWalletClient({
        account:   this.account,
        chain:     base,
        transport: http(process.env.BASE_RPC || "https://mainnet.base.org"),
      });

      this.publicClient = createPublicClient({
        chain:     base,
        transport: http(process.env.BASE_RPC || "https://mainnet.base.org"),
      });

      this.ethClient = createPublicClient({
        chain:     mainnet,
        transport: http(process.env.ETH_RPC || "https://eth.llamarpc.com"),
      });

      this.initialized = true;
      console.log(`On-chain client initialized for ${this.wallet}`);
      return true;
    } catch (err: any) {
      console.error("On-chain init failed:", err.message);
      return false;
    }
  }

  async getBaseBalance(): Promise<string> {
    try {
      const balance = await this.publicClient.getBalance({
        address: this.wallet as `0x${string}`,
      });
      return formatEther(balance);
    } catch {
      return "0";
    }
  }

  async getEthBalance(): Promise<string> {
    try {
      const balance = await this.ethClient.getBalance({
        address: this.wallet as `0x${string}`,
      });
      return formatEther(balance);
    } catch {
      return "0";
    }
  }

  async checkAndSweep(): Promise<boolean> {
    try {
      if (!this.initialized) return false;
      const balance    = parseFloat(await this.getBaseBalance());
      const threshold  = AUTO_SWEEP_ETH + MIN_BALANCE_ETH;

      if (balance > threshold) {
        const sweepAmount = balance - MIN_BALANCE_ETH;
        console.log(`Sweeping ${sweepAmount.toFixed(4)} ETH to holder wallet...`);

        const hash = await this.walletClient.sendTransaction({
          to:    getAddress(HOLDER_WALLET) as `0x${string}`,
          value: parseEther(sweepAmount.toFixed(6)),
        });

        console.log(`✓ Sweep TX: ${hash}`);
        return true;
      }
      return false;
    } catch (err: any) {
      console.error("Sweep failed:", err.message);
      return false;
    }
  }

  async endorseWallet(wallet: string, context: string): Promise<boolean> {
    try {
      const res = await fetch(`${AGENTCHECK_URL}/api/endorse`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          endorser: this.wallet,
          endorsed: wallet,
          context,
        }),
      });
      const data = await res.json() as any;
      if (data.ok || data.message) {
        console.log(`✓ Endorsed ${wallet.slice(0, 10)}...: ${context}`);
        return true;
      }
      return false;
    } catch (err: any) {
      console.error("Endorse failed:", err.message);
      return false;
    }
  }

  async reportOutcome(
    counterparty: string,
    outcome:      "positive" | "negative" | "neutral",
    context:      string,
    txHash?:      string
  ): Promise<boolean> {
    try {
      const res = await fetch(`${AGENTCHECK_URL}/api/outcome`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          wallet:    counterparty,
          reporter:  this.wallet,
          outcome,
          context,
          tx_hash:   txHash,
        }),
      });
      const data = await res.json() as any;
      if (data.ok || data.message) {
        console.log(`✓ Outcome reported: ${counterparty.slice(0, 10)}... → ${outcome}`);
        return true;
      }
      return false;
    } catch (err: any) {
      console.error("Outcome report failed:", err.message);
      return false;
    }
  }

  async flagWallet(
    wallet:   string,
    reason:   string,
    evidence: string,
    severity: "low" | "medium" | "high" | "critical"
  ): Promise<boolean> {
    try {
      const res = await fetch(`${AGENTCHECK_URL}/api/flag`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          wallet,
          reporter: this.wallet,
          reason,
          evidence,
          severity,
        }),
      });
      const data = await res.json() as any;
      if (data.ok || data.message) {
        console.log(`✓ Flagged ${wallet.slice(0, 10)}...: ${reason}`);
        return true;
      }
      return false;
    } catch (err: any) {
      console.error("Flag failed:", err.message);
      return false;
    }
  }

  async registerCertification(agentEndpoint: string): Promise<any> {
    try {
      const res = await fetch(`${AGENTCHECK_URL}/api/certify`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          wallet:         this.wallet,
          agent_endpoint: agentEndpoint,
          test_suite:     "all",
        }),
      });
      return await res.json();
    } catch (err: any) {
      console.error("Certification failed:", err.message);
      return null;
    }
  }

  getWallet(): string { return this.wallet; }
  isInitialized(): boolean { return this.initialized; }
}
