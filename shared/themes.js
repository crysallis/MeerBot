export const THEMES = [
    { value: 'jewel',     label: 'Jewel',     mode: 'dark'  },
    { value: 'chili',     label: 'Chili',     mode: 'light' },
    { value: 'tigereye',  label: 'Tigereye',  mode: 'dark'  },
    { value: 'plum',      label: 'Plum',      mode: 'dark'  },
    { value: 'lapis',     label: 'Lapis',     mode: 'dark'  },
    { value: 'synthwave', label: 'Synthwave', mode: 'dark'  },
    { value: 'purple',    label: 'Purple',    mode: 'dark'  },
];

export function themeMode(value) {
    return (THEMES.find(t => t.value === value) || THEMES[0]).mode;
}
