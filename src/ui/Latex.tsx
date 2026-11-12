import katex from 'katex';
import 'katex/dist/katex.min.css';
import { useMemo } from 'react';

export function Latex({ tex, block = false }: { tex: string; block?: boolean }) {
  const html = useMemo(
    () => katex.renderToString(tex, { displayMode: block, throwOnError: false, strict: 'ignore' }),
    [tex, block],
  );
  return <span className={block ? 'latex latex-block' : 'latex'} dangerouslySetInnerHTML={{ __html: html }} />;
}
