/** Component-scoped styles; colors come only from the Harness theme tokens so light/dark follow the host. */
export const STYLES = `
.cy-root{font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);height:100%;overflow:auto;padding:10px 12px;box-sizing:border-box}
.cy-header{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.cy-title{font-weight:600;font-size:15px;flex:0 0 auto}
.cy-sub{color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:12px}
.cy-select{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:3px 6px;font-size:12px;max-width:240px}
.cy-header .cy-select{flex:1 1 auto}
.cy-openrow{display:flex;gap:6px;margin:6px 0}
.cy-input{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 8px;font-size:12px}
.cy-btn{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-state-business-primary));color:var(--dsw-alias-label-primary-inverted,#fff);border:none;border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer}
.cy-btn:disabled{opacity:.5;cursor:default}
.cy-btn.cy-ghost{background:transparent;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2)}
.cy-btn.cy-ghost:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cy-link{background:none;border:none;color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary));cursor:pointer;font-size:12px;margin-left:auto}
.cy-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1);margin:8px 0;overflow-x:auto}
.cy-tab{background:none;border:none;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);padding:6px 8px;cursor:pointer;white-space:nowrap;font-size:12px}
.cy-tab.cy-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary)}
.cy-empty{color:var(--dsw-alias-label-tertiary);padding:24px 4px;text-align:center}
.cy-error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:4px 0;word-break:break-word}
.cy-ok{color:var(--dsw-alias-state-success-primary)}
.cy-muted{color:var(--dsw-alias-label-tertiary)}
.cy-small{font-size:12px}
.cy-row{display:flex;align-items:center;gap:6px;min-width:0}
.cy-path{font-size:12px;color:var(--dsw-alias-label-tertiary);word-break:break-all;margin-bottom:6px}
.cy-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:6px}
.cy-stat{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:6px 8px}
.cy-stat-v{font-size:17px;font-weight:600}
h4{margin:12px 0 6px;font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:600}
.cy-chips{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0}
.cy-chip{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 7px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.cy-chip.cy-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.cy-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:0 0 auto}
.cy-st-running,.cy-st-queued{background:var(--dsw-alias-state-business-primary)}
.cy-st-succeeded,.cy-st-completed{background:var(--dsw-alias-state-success-primary)}
.cy-st-failed{background:var(--dsw-alias-state-error-primary)}
.cy-st-paused,.cy-st-waiting-authorization{background:var(--dsw-alias-state-warn-primary)}
.cy-chip.cy-st-running,.cy-chip.cy-st-queued,.cy-chip.cy-st-succeeded,.cy-chip.cy-st-failed,.cy-chip.cy-st-paused,.cy-chip.cy-st-cancelled,.cy-chip.cy-st-waiting-authorization{background:transparent}
.cy-activities{margin:6px 0}
.cy-activity{background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:6px 8px;margin-bottom:4px;font-size:12px}
.cy-bar{height:4px;border-radius:2px;background:var(--dsw-alias-fill-l1,var(--dsw-alias-border-l1));margin-top:4px;overflow:hidden}
.cy-bar-fill{height:100%;background:var(--dsw-alias-state-business-primary);transition:width .4s}
.cy-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:6px 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.cy-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:6px}
.cy-cell{position:relative;border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);cursor:pointer;border:2px solid transparent}
.cy-cell img{width:100%;aspect-ratio:3/2;object-fit:cover;display:block}
.cy-cell.cy-picked{border-color:var(--dsw-alias-state-success-primary)}
.cy-cell.cy-rejected{opacity:.45}
.cy-scores{display:flex;gap:3px;padding:3px 4px;flex-wrap:wrap}
.cy-score{font-size:10px;border-radius:4px;padding:0 4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.cy-good{color:var(--dsw-alias-state-success-primary)}
.cy-mid{color:var(--dsw-alias-state-warn-primary)}
.cy-low{color:var(--dsw-alias-state-error-primary)}
.cy-issue{position:absolute;top:3px;left:3px;font-size:10px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.55));color:#fff;border-radius:4px;padding:0 4px;max-width:90%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cy-drawer{position:fixed;right:12px;top:56px;bottom:12px;width:min(420px,calc(100% - 24px));background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:10px;overflow:auto;z-index:20;box-shadow:0 8px 28px rgba(0,0,0,.25)}
.cy-drawer.cy-wide{width:min(640px,calc(100% - 24px))}
.cy-preview{width:100%;border-radius:8px;display:block;margin:6px 0}
.cy-table{border-collapse:collapse;width:100%;font-size:12px;margin:4px 0}
.cy-table td,.cy-table th{padding:2px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);text-align:left}
.cy-actions{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.cy-list{display:flex;flex-direction:column;gap:6px}
.cy-item{display:flex;gap:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:6px}
.cy-item img{width:96px;height:64px;object-fit:cover;border-radius:6px;flex:0 0 auto;cursor:pointer}
.cy-item-body{min-width:0;flex:1}
.cy-dim{opacity:.5}
.cy-ellipsis{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cy-compare{position:relative;user-select:none;cursor:ew-resize;border-radius:8px;overflow:hidden;margin:6px 0;aspect-ratio:3/2;background:var(--dsw-alias-bg-layer-2)}
.cy-compare img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block}
.cy-compare-handle{position:absolute;top:0;bottom:0;width:2px;background:#fff;box-shadow:0 0 4px rgba(0,0,0,.5);pointer-events:none}
.cy-revs{display:flex;flex-wrap:wrap;gap:4px}
.cy-rev{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:11px;padding:2px 6px;cursor:pointer}
.cy-rev.cy-active{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.cy-steps{margin:2px 0 6px 16px;padding:0}
.cy-steps code{font-size:11px}
.cy-log{font-family:ui-monospace,Menlo,monospace;font-size:11px;max-height:320px;overflow:auto;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:6px}
.cy-log-error{color:var(--dsw-alias-state-error-primary)}
.cy-log-warn{color:var(--dsw-alias-state-warn-primary)}
`
