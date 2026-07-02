/**
 * Tree Navigator webview entry point — search, priority chips, lane toggles,
 * age jump-bar, and minimap for the tech-tree canvas (P2 spec §3).
 */
import { mount } from 'svelte';
import TreeNavigator from '../components/navigator/TreeNavigator.svelte';

const target = document.getElementById('app');
if (target) {
  mount(TreeNavigator, { target });
}

export {};
