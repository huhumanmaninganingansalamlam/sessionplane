import type { PreparationTarget } from '../domain/preparation.ts';
import type { BrowserSnapshotNode } from './ref-snapshot.ts';

export function matchesPreparationTarget(
  node: BrowserSnapshotNode,
  target: PreparationTarget,
): boolean {
  const normalize = (value: string): string => value.replaceAll(/\s+/g, ' ').trim();
  return node.role === target.role && node.tag === target.tag && node.name === target.name &&
    (target.id === '' || node.id === target.id) &&
    (target.purpose === 'composer' || normalize(node.text) === normalize(target.text)) &&
    (target.placeholder === null || node.placeholder === target.placeholder);
}

export function isPreparationSummary(node: BrowserSnapshotNode, insideMenu: boolean): boolean {
  return node.role === 'menuitem' && node.name.trim() !== '' && node.text.trim() !== '' &&
    node.text.trim() !== node.name.trim() && insideMenu;
}

export function hasPreparationSelectionEvidence(
  nodes: readonly BrowserSnapshotNode[],
  target: PreparationTarget,
): boolean {
  const normalize = (value: string): string => value.replaceAll(/\s+/g, ' ').trim().toLowerCase();
  if (target.role === 'slider' && target.selectedValue !== null) {
    return nodes.some((node) => matchesPreparationTarget(node, target) &&
      Number(node.ariaValueNow ?? node.value) === target.selectedValue);
  }
  if (target.role === 'menuitem') return nodes.some((node) => matchesPreparationTarget(node, target) &&
    isPreparationSummary(node, nodes.some((parent) =>
      parent.role === 'menu' && parent.id !== '' && node.ancestorIds.includes(parent.id))));
  if (target.role === 'button') return nodes.some((node) => matchesPreparationTarget(node, target) &&
    node.hasPopup !== null);
  if (nodes.some((node) => matchesPreparationTarget(node, target) &&
      (node.selected === true || node.checked === true))) return true;
  const choice = normalize(target.name || target.text);
  return choice !== '' && nodes.some((node) => ['button', 'combobox'].includes(node.role) &&
    node.controls.some((id) => target.ancestorIds.includes(id)) &&
    normalize(`${node.name} ${node.text}`).includes(choice));
}
