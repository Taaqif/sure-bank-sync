/** American Express (Australia). Scraper implemented in the next phase. */
import { ProviderError, type ProviderDefinition } from "./base.js";

export const amex: ProviderDefinition = {
  name: "amex",
  label: "American Express (AU)",
  credentialFields: [
    { key: "username", label: "User ID" },
    { key: "password", label: "Password", secret: true },
  ],
  create: () => ({
    async login() {
      throw new ProviderError("Amex provider not implemented yet");
    },
    async fetchTransactions() {
      throw new ProviderError("Amex provider not implemented yet");
    },
  }),
};
