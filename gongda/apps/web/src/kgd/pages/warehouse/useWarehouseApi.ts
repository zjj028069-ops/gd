import { useKgd } from '../../context';
import { useCommand } from '../../kit';

export type WhRec = { id: string; [key: string]: any };

export function useWarehouseApi() {
  const kgd = useKgd();
  const command = useCommand();
  return { ...kgd, ...command };
}
