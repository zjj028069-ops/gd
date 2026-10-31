import { Checkbox, Radio } from 'antd';

type Point = { code: string; name: string; scopes?: ('self' | 'team' | 'all')[] };
type Group = { name: string; points: Point[] };
type Module = { key: string; name: string; groups: Group[] };

const scopeText = { self: '个人权限', team: '团队权限', all: '全部权限' } as const;

export function PermissionTree({ modules, points, scopes, onChange }: {
  modules: Module[];
  points: string[];
  scopes: Record<string, 'self' | 'team' | 'all'>;
  onChange: (points: string[], scopes: Record<string, 'self' | 'team' | 'all'>) => void;
}) {
  function toggle(code: string, checked: boolean) {
    const next = checked ? [...new Set([...points, code])] : points.filter((item) => item !== code);
    const scope = scopes[code] ?? 'all';
    onChange(next, { ...scopes, [code]: scope });
  }
  function toggleGroup(group: Group, checked: boolean) {
    const codes = group.points.map((point) => point.code);
    const next = checked ? [...new Set([...points, ...codes])] : points.filter((item) => !codes.includes(item));
    const nextScopes = { ...scopes };
    for (const point of group.points) if (point.scopes && !nextScopes[point.code]) nextScopes[point.code] = 'all';
    onChange(next, nextScopes);
  }
  return <div>
    {modules.map((module) => <section key={module.key} style={{ marginBottom: 16 }}>
      <h3>{module.name}</h3>
      {module.groups.map((group) => {
        const codes = group.points.map((point) => point.code);
        const all = codes.every((code) => points.includes(code));
        return <div key={group.name} style={{ marginBottom: 8 }}>
          <div>{group.name} <Checkbox checked={all} onChange={(event) => toggleGroup(group, event.target.checked)}>全部</Checkbox></div>
          {group.points.map((point) => <div key={point.code} style={{ marginLeft: 16 }}>
            <Checkbox checked={points.includes(point.code)} onChange={(event) => toggle(point.code, event.target.checked)}>{point.name}</Checkbox>
            {point.scopes && <Radio.Group style={{ marginLeft: 12 }} value={scopes[point.code] ?? 'all'} onChange={(event) => onChange(points, { ...scopes, [point.code]: event.target.value })}>
              {point.scopes.map((scope) => <Radio key={scope} value={scope}>{scopeText[scope]}</Radio>)}
            </Radio.Group>}
          </div>)}
        </div>;
      })}
    </section>)}
  </div>;
}
