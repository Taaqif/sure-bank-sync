/** ANZ Internet Banking (Australia). Scraper implemented in the next phase. */
import { ProviderError, type ProviderDefinition } from "./base.js";

export const anz: ProviderDefinition = {
  name: "anz",
  label: "ANZ Internet Banking",
  credentialFields: [
    { key: "customer_id", label: "Customer Registration Number" },
    { key: "password", label: "Password", secret: true },
  ],
  create: () => ({
    async login() {
      throw new ProviderError("ANZ provider not implemented yet");
    },
    async fetchTransactions() {
      throw new ProviderError("ANZ provider not implemented yet");
    },
  }),
};
