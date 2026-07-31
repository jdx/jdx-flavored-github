interface StackMetadata {
	baseKey?: string;
	headKey?: string;
}

interface StackItem {
	metadata: StackMetadata;
}

export function findStackComponents<T extends StackItem>(items: T[]): T[][] {
	const parent = items.map((_, index) => index);
	const find = (start: number) => {
		let index = start;
		while (parent[index] !== index) {
			parent[index] = parent[parent[index]];
			index = parent[index];
		}
		return index;
	};
	const join = (left: number, right: number) => {
		const leftRoot = find(left);
		const rightRoot = find(right);
		if (leftRoot !== rightRoot) {
			parent[rightRoot] = leftRoot;
		}
	};

	for (let left = 0; left < items.length; left++) {
		for (let right = left + 1; right < items.length; right++) {
			if (
				(
					items[left].metadata.baseKey
					&& items[right].metadata.headKey
					&& items[left].metadata.baseKey === items[right].metadata.headKey
				)
				|| (
					items[right].metadata.baseKey
					&& items[left].metadata.headKey
					&& items[right].metadata.baseKey === items[left].metadata.headKey
				)
			) {
				join(left, right);
			}
		}
	}

	const groups = new Map<number, T[]>();
	for (let index = 0; index < items.length; index++) {
		const root = find(index);
		const group = groups.get(root) ?? [];
		group.push(items[index]);
		groups.set(root, group);
	}
	return [...groups.values()].filter(group => group.length > 1);
}

export function orderStackItems<T extends StackItem>(items: T[]): T[] {
	const remaining = new Set(items);
	const headKeys = new Set(items.map(item => item.metadata.headKey).filter(Boolean));
	const ordered: T[] = [];
	const visit = (item: T) => {
		if (!remaining.delete(item)) {
			return;
		}
		ordered.push(item);
		for (const child of items) {
			if (child.metadata.baseKey === item.metadata.headKey) {
				visit(child);
			}
		}
	};

	for (const item of items) {
		if (item.metadata.baseKey && !headKeys.has(item.metadata.baseKey)) {
			visit(item);
		}
	}
	for (const item of items) {
		visit(item);
	}
	return ordered;
}

export function isDependencyUpdateAuthor(author: string): boolean {
	return /^(?:app\/)?(?:dependabot|renovate)(?:\[bot\]|-bot)?$/i.test(author);
}
