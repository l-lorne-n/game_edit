import { HostTokenService } from '@/lib/host-tokens/server/service';
import { NeonHostTokenStore } from '@/lib/host-tokens/server/neon-store';

let cachedHostTokenService: HostTokenService | null = null;

export function getHostTokenService(): HostTokenService {
  if (!cachedHostTokenService) {
    cachedHostTokenService = new HostTokenService(new NeonHostTokenStore());
  }
  return cachedHostTokenService;
}

export function resetHostTokenServiceForTests(): void {
  cachedHostTokenService = null;
}
