import {createIcons, ArrowLeft, Axis3d, Box, Brush, Check, ChevronLeft, ChevronRight, Crosshair, Eye, EyeOff, FileText, Flashlight, Focus, Image, Info, Layers3, Lightbulb, Link2, ListFilter, Maximize2, Minus, MousePointer2, MoveDiagonal2, Paintbrush, PenLine, Pencil, Plus, Redo2, RotateCcw, Ruler, ScanEye, ScanLine, Share2, SlidersHorizontal, Spline, Sun, Trash2, Undo2, X} from 'lucide';

/** Lucide icons are installed only where the application owns the DOM. */
export function installIcons(root: Element | Document = document): void {
  createIcons({
    root,
    icons: {ArrowLeft, Axis3d, Box, Brush, Check, ChevronLeft, ChevronRight, Crosshair, Eye, EyeOff, FileText, Flashlight, Focus, Image, Info, Layers3, Lightbulb, Link2, ListFilter, Maximize2, Minus, MousePointer2, MoveDiagonal2, Paintbrush, PenLine, Pencil, Plus, Redo2, RotateCcw, Ruler, ScanEye, ScanLine, Share2, SlidersHorizontal, Spline, Sun, Trash2, Undo2, X},
    attrs: {'aria-hidden':'true', 'stroke-width':1.8},
  });
}
