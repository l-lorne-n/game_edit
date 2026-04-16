import type { GeneratedGamePackage } from '@/lib/package/contracts';
import { decideRoute } from '@/lib/workspace/routing';
import type { ActionMode, RouteDecision } from '@/lib/workspace/types';

export function computePackageRouteDecision(input: {
  mode: ActionMode;
  requestText: string;
  targetId: string;
  targetPackage: GeneratedGamePackage | null;
}): RouteDecision {
  return decideRoute(input);
}
