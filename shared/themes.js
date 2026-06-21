export const THEMES = [
    { value: 'caramellatte', label: 'Caramellatte', mode: 'dark'  },
    { value: 'autumn',       label: 'Autumn',       mode: 'light' },
    { value: 'fantasy',      label: 'Fantasy',      mode: 'dark'  },
    { value: 'abyss',        label: 'Abyss',        mode: 'dark'  },
    { value: 'ocean',        label: 'Ocean',        mode: 'dark'  },
    { value: 'synthwave',    label: 'Synthwave',    mode: 'dark'  },
    { value: 'aqua',         label: 'Aqua',         mode: 'dark'  },
];

export function themeMode(value) {
    return (THEMES.find(t => t.value === value) || THEMES[0]).mode;
}
