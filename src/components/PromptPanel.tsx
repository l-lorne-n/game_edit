'use client';

import { useState } from 'react';

type Props = {
  onGenerate: (prompt: string) => Promise<void>;
  onModify: (instruction: string) => Promise<void>;
  disabled: boolean;
  hasEditableGame: boolean;
  modifyBaseType: 'staged' | 'live' | 'archive';
  onModifyBaseTypeChange: (value: 'staged' | 'live' | 'archive') => void;
  modifyArchiveId: string;
  onModifyArchiveIdChange: (value: string) => void;
  modifyArchiveOptions: Array<{ id: string; label: string }>;
};

const samplePrompt =
  '做一个太空主题躲避生存游戏，方向键移动，存活45秒获胜，加入金币得分。';

export default function PromptPanel({
  onGenerate,
  onModify,
  disabled,
  hasEditableGame,
  modifyBaseType,
  onModifyBaseTypeChange,
  modifyArchiveId,
  onModifyArchiveIdChange,
  modifyArchiveOptions,
}: Props) {
  const [prompt, setPrompt] = useState(samplePrompt);
  const [instruction, setInstruction] = useState('把敌人速度稍微提高，并把背景改成更暗的蓝色。');

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 16,
      }}
    >
      <h2 style={{ margin: 0, fontSize: 18 }}>Prompt</h2>
      <textarea
        value={prompt}
        onChange={event => setPrompt(event.target.value)}
        rows={6}
        disabled={disabled}
        style={{
          width: '100%',
          resize: 'vertical',
          borderRadius: 10,
          border: '1px solid var(--border)',
          background: 'var(--panel-2)',
          color: 'var(--text)',
          padding: 10,
        }}
      />
      <button
        type="button"
        disabled={disabled || !prompt.trim()}
        onClick={() => onGenerate(prompt.trim())}
        style={{
          border: 'none',
          borderRadius: 10,
          background: 'var(--accent)',
          color: '#04111f',
          fontWeight: 700,
          padding: '10px 12px',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        生成可玩原型
      </button>

      <h3 style={{ margin: '8px 0 0', fontSize: 16 }}>迭代修改</h3>
      <div style={{ display: 'grid', gap: 8 }}>
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>修改基线</span>
          <select
            value={modifyBaseType}
            onChange={event =>
              onModifyBaseTypeChange(event.target.value as 'staged' | 'live' | 'archive')
            }
            disabled={disabled || !hasEditableGame}
            style={{
              borderRadius: 10,
              border: '1px solid var(--border)',
              background: 'var(--panel-2)',
              color: 'var(--text)',
              padding: '8px 10px',
            }}
          >
            <option value="staged">优先使用 Staged 草稿</option>
            <option value="live">当前 Live 版本</option>
            <option value="archive">指定归档版本</option>
          </select>
        </label>

        {modifyBaseType === 'archive' ? (
          <label style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>归档基线</span>
            <select
              value={modifyArchiveId}
              onChange={event => onModifyArchiveIdChange(event.target.value)}
              disabled={disabled || !hasEditableGame || modifyArchiveOptions.length === 0}
              style={{
                borderRadius: 10,
                border: '1px solid var(--border)',
                background: 'var(--panel-2)',
                color: 'var(--text)',
                padding: '8px 10px',
              }}
            >
              <option value="">选择归档版本</option>
              {modifyArchiveOptions.map(option => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <textarea
        value={instruction}
        onChange={event => setInstruction(event.target.value)}
        rows={4}
        disabled={disabled || !hasEditableGame}
        style={{
          width: '100%',
          resize: 'vertical',
          borderRadius: 10,
          border: '1px solid var(--border)',
          background: 'var(--panel-2)',
          color: 'var(--text)',
          padding: 10,
        }}
      />
      <button
        type="button"
        disabled={
          disabled ||
          !hasEditableGame ||
          !instruction.trim() ||
          (modifyBaseType === 'archive' && !modifyArchiveId)
        }
        onClick={() => onModify(instruction.trim())}
        style={{
          border: '1px solid var(--accent)',
          borderRadius: 10,
          background: 'transparent',
          color: 'var(--text)',
          fontWeight: 700,
          padding: '10px 12px',
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        应用修改
      </button>
    </section>
  );
}
