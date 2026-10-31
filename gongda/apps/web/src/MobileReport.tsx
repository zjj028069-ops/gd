import { Link } from 'react-router-dom';
import type { Session } from './api';

type DeskProps = { session: Session; revision: number; onExpired: () => void; onChanged: () => void };

export function MobileReport(_props: DeskProps) {
  return <section className="panel">
    <h2>移动报工</h2>
    <p>移动报工已迁至 <Link to="/m/report">/m/report</Link>。报工提交后直接生效，并计入良品进度和工资。</p>
  </section>;
}
