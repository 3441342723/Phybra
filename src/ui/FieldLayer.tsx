import { FIELD_COLORS, fieldLabel, hasGradient, isPointSource, magneticAt, shapeCenter, shapeVertices, vectorAt } from '../model/fields';
import type { Field, Link, Vec2 } from '../model/types';

export function FieldLayer({ fields, links, selection, toScreen, linkBody, draft, draftColor }: {
  fields: Field[]; links: Link[]; selection: string | null; toScreen: (p: Vec2) => Vec2;
  linkBody: (link: Link) => Vec2 | null; draft: Vec2[]; draftColor?: string;
}) {
  const labelPoint = (p: Vec2) => {
    const s=toScreen(p);
    return `${s.x},${s.y}`;
  };
  const centers = fields.map(f => toScreen(shapeCenter(f.shape,f.position)));
  return <>
    {fields.map((f,index) => {
      const {shape}=f, pos=toScreen(f.position), p=centers[index];
      const center=shapeCenter(shape,f.position);
      const coincident=centers.map((center,i)=>Math.hypot(center.x-p.x,center.y-p.y)<1?i:-1).filter(i=>i>=0);
      const symbol={x:p.x+(coincident.indexOf(index)-(coincident.length-1)/2)*34,y:p.y};
      const vertices=shapeVertices(shape);
      const selected=selection===f.id, color=FIELD_COLORS[f.kind];
      const radius=shape.kind==='circle'?Math.abs(toScreen({x:shape.center.x+shape.radius,y:shape.center.y}).x-p.x):0;
      const vector=vectorAt(f,center);
      const bz=f.kind==='uniform_magnetic'?magneticAt(f,center):0;
      const mag=vector?Math.hypot(vector.x,vector.y):0;
      const tip={x:symbol.x+(vector&&mag?vector.x*22/mag:0),y:symbol.y-(vector&&mag?vector.y*22/mag:0)};
      const tipAngle=Math.atan2(tip.y-symbol.y,tip.x-symbol.x);
      const plates=f.kind==='uniform_electric'&&f.plates&&shape.kind==='rect'
        ? f.plates.axis==='x'?[[0,3],[1,2]]:[[0,1],[3,2]] : [];
      const marker=(position:Vec2,handle:string,key=handle)=>{
        const pt=toScreen(position);
        return <circle key={key} cx={pt.x} cy={pt.y} r={6} className="field-handle" data-field={f.id} data-field-handle={handle} />;
      };
      return <g key={f.id} style={{color,opacity:f.enabled?1:0.42}}>
        <title>{f.name+' · '+fieldLabel(f)+(shape.kind==='global'?'（全局）':'')}</title>
        {shape.kind==='circle' && radius>0 && <circle cx={p.x} cy={p.y} r={radius} className={selected?'field-region selected-field':'field-region'} data-field={f.id} data-field-handle="move" />}
        {vertices.length>0 && <polygon points={vertices.map(labelPoint).join(' ')} className={selected?'field-region selected-field':'field-region'} data-field={f.id} data-field-handle="move" />}
        {plates.map(([a,b])=><polyline key={a} points={[vertices[a],vertices[b]].map(labelPoint).join(' ')}
          stroke="currentColor" strokeWidth={3} fill="none" pointerEvents="none" />)}
        {!isPointSource(f) && <g className="field-symbol" data-field={f.id} data-field-handle="move">
          <circle cx={symbol.x} cy={symbol.y} r={9} className="field-glyph" />
          {f.kind==='uniform_magnetic' ? <text x={symbol.x} y={symbol.y} dominantBaseline="central" textAnchor="middle" fill="currentColor">{bz>0?'•':bz<0?'×':'0'}</text>
            : mag>0 ? <g stroke="currentColor" fill="none" strokeWidth={2}>
              <path d={`M ${symbol.x} ${symbol.y} L ${tip.x} ${tip.y} l ${-7*Math.cos(tipAngle-0.5)} ${-7*Math.sin(tipAngle-0.5)} M ${tip.x} ${tip.y} l ${-7*Math.cos(tipAngle+0.5)} ${-7*Math.sin(tipAngle+0.5)}`} />
            </g> : null}
        </g>}
        {isPointSource(f) && <g className="field-symbol" data-field={f.id} data-field-handle="source">
          <circle cx={pos.x} cy={pos.y} r={8} className="field-glyph" />
          <text x={pos.x} y={pos.y} dominantBaseline="central" textAnchor="middle" fill="currentColor">
            {f.kind==='point_mass'?'M':f.sourceStrength<0?'−':f.sourceStrength>0?'+':'0'}
          </text>
        </g>}
        {selected && shape.kind==='rect' && vertices.map((v,i)=>marker(v,`corner-${i}`))}
        {selected && shape.kind==='circle' && marker({x:shape.center.x+shape.radius,y:shape.center.y},'radius')}
        {selected && shape.kind==='polygon' && vertices.map((v,i)=>marker(v,`vertex-${i}`))}
        {selected && hasGradient(f) && shape.kind!=='global' && marker(f.position,'source')}
      </g>;
    })}
    {links.map(l=>{
      const a=toScreen(l.anchor), end=linkBody(l), b=end?toScreen(end):{x:a.x+22,y:a.y};
      return <g key={l.id} data-link={l.id} className={selection===l.id?'selected-link':''}>
        <title>{l.name}</title>
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={l.kind==='rope'?'physical-link rope-link':'physical-link'} />
        <circle cx={a.x} cy={a.y} r={6} className="link-anchor" />
      </g>;
    })}
    {draft.length>0 && <g className="field-draft" style={{stroke:draftColor}}>
      <polyline points={draft.map(labelPoint).join(' ')} fill="none" />
      {draft.map((v,i)=>{const p=toScreen(v);return <circle key={i} cx={p.x} cy={p.y} r={i===0?7:4} />;})}
    </g>}
  </>;
}
