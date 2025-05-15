import { Chart } from 'chart.js';
import type { ChartTypeRegistry, Point, BubbleDataPoint } from 'chart.js';

export type Edge = 'start' | 'end' | null;

interface DragState {
  isDragging: boolean;
  edge: Edge;
  initialX: number | null;
  currentValue: number | null;
  visualStart: number;
  visualEnd: number;
  isDragFromMargin: boolean;
}

export interface DragControllerOptions {
  chart: Chart<keyof ChartTypeRegistry, (number | [number, number] | Point | BubbleDataPoint | null)[], unknown> | null;
  onLoopChange: ((start: number, end: number) => void) | null;
  loopStart: number;
  loopEnd: number;
  edgeThresholdPixels?: number;
  marginThresholdPixels?: number;
  maxDragLimit?: number;
  onDragStart?: () => void;
}

export class DragController {
  private dragState: DragState = {
    isDragging: false,
    edge: null,
    initialX: null,
    currentValue: null,
    visualStart: 0,
    visualEnd: 0,
    isDragFromMargin: false
  };

  private chart: Chart<keyof ChartTypeRegistry, (number | [number, number] | Point | BubbleDataPoint | null)[], unknown> | null;
  private onLoopChange: ((start: number, end: number) => void) | null;
  private loopStart: number;
  private loopEnd: number;
  private edgeThresholdPixels: number;
  private marginThresholdPixels: number;
  private maxDragLimit: number;
  private onDragStart?: () => void;

  constructor(options: DragControllerOptions) {
    this.chart = options.chart;
    this.onLoopChange = options.onLoopChange;
    this.loopStart = options.loopStart;
    this.loopEnd = options.loopEnd;
    this.edgeThresholdPixels = options.edgeThresholdPixels || 10;
    this.marginThresholdPixels = options.marginThresholdPixels || 50;
    this.maxDragLimit = options.maxDragLimit || Infinity;
    this.dragState.visualStart = this.loopStart;
    this.dragState.visualEnd = this.loopEnd;
    this.onDragStart = options.onDragStart;
  }

  public updateValues(options: Partial<DragControllerOptions>) {
    if (options.chart !== undefined) this.chart = options.chart;
    if (options.onLoopChange !== undefined) this.onLoopChange = options.onLoopChange;
    if (options.loopStart !== undefined && !this.dragState.isDragging) {
      this.loopStart = options.loopStart;
      this.dragState.visualStart = options.loopStart;
    }
    if (options.loopEnd !== undefined && !this.dragState.isDragging) {
      this.loopEnd = options.loopEnd;
      this.dragState.visualEnd = options.loopEnd;
    }
    if (options.edgeThresholdPixels !== undefined) this.edgeThresholdPixels = options.edgeThresholdPixels;
    if (options.marginThresholdPixels !== undefined) this.marginThresholdPixels = options.marginThresholdPixels;
    if (options.maxDragLimit !== undefined) this.maxDragLimit = options.maxDragLimit;
    if (options.onDragStart !== undefined) this.onDragStart = options.onDragStart;
  }

  public isDragging(): boolean {
    return this.dragState.isDragging;
  }

  public getCurrentEdge(): Edge {
    return this.dragState.edge;
  }

  public getCurrentValue(): number | null {
    return this.dragState.currentValue;
  }

  public getVisualValues(): { start: number; end: number } {
    return {
      start: this.dragState.visualStart,
      end: this.dragState.visualEnd
    };
  }

  private getChartCoordinates(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
    if (!this.chart?.canvas) return null;

    const canvas = this.chart.canvas;
    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX;
    const clientY = 'touches' in event ? event.touches[0].clientY : event.clientY;

    // Get the relative position within the canvas
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    // Convert to chart values using Chart.js's built-in methods
    return {
      x: this.chart.scales.x.getValueForPixel(x) ?? 0,
      y: this.chart.scales.y.getValueForPixel(y) ?? 0
    };
  }

  private getCanvasCoordinates(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
    if (!this.chart?.canvas) return null;

    const canvas = this.chart.canvas;
    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX;
    const clientY = 'touches' in event ? event.touches[0].clientY : event.clientY;

    // Get the relative position within the canvas
    return {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  }

  private getNearestEdge(x: number): Edge {
    if (!this.chart?.scales?.x) return null;

    const xScale = this.chart.scales.x;
    const startPixel = xScale.getPixelForValue(this.dragState.visualStart);
    const endPixel = xScale.getPixelForValue(this.dragState.visualEnd);
    const xPixel = xScale.getPixelForValue(x);

    // Calculate distances in pixels
    const distanceToStart = Math.abs(xPixel - startPixel);
    const distanceToEnd = Math.abs(xPixel - endPixel);

    if (distanceToStart <= this.edgeThresholdPixels && distanceToStart <= distanceToEnd) return 'start';
    if (distanceToEnd <= this.edgeThresholdPixels) return 'end';
    return null;
  }

  private isInMarginArea(canvasX: number): Edge | null {
    if (!this.chart?.scales?.x) return null;
    
    const chartArea = this.chart.chartArea;
    
    if (canvasX < chartArea.left && canvasX >= chartArea.left - this.marginThresholdPixels) {
      return 'start';
    }
    
    if (canvasX > chartArea.right && canvasX <= chartArea.right + this.marginThresholdPixels) {
      return 'end';
    }
    
    return null;
  }

  public handleMouseDown = (event: MouseEvent | TouchEvent): boolean => {
    const coords = this.getChartCoordinates(event);
    const canvasCoords = this.getCanvasCoordinates(event);
    
    if (!coords || !canvasCoords) return false;

    const edge = this.getNearestEdge(coords.x);
    
    const marginEdge = edge ? null : this.isInMarginArea(canvasCoords.x);
    
    if (!edge && !marginEdge) return false;

    event.preventDefault();
    event.stopPropagation();

    const selectedEdge = edge || marginEdge;
    const isDragFromMargin = !!marginEdge;
    
    let initialValue;
    if (isDragFromMargin) {
      if (selectedEdge === 'start') {
        initialValue = this.chart?.scales?.x?.min ?? 0;
        this.dragState.visualStart = initialValue;
      } else {
        initialValue = this.chart?.scales?.x?.max ?? 5;
        this.dragState.visualEnd = initialValue;
      }
    } else {
      initialValue = selectedEdge === 'start' ? this.dragState.visualStart : this.dragState.visualEnd;
    }

    this.dragState = {
      isDragging: true,
      edge: selectedEdge,
      initialX: coords.x,
      currentValue: initialValue,
      visualStart: this.dragState.visualStart,
      visualEnd: this.dragState.visualEnd,
      isDragFromMargin
    };

    // Call onDragStart callback if provided
    if (this.onDragStart) {
      this.onDragStart();
    }

    return true;
  };

  public handleMouseMove = (event: MouseEvent | TouchEvent): void => {
    if (!this.dragState.isDragging || !this.chart?.options?.plugins) return;

    event.preventDefault();
    event.stopPropagation();

    const coords = this.getChartCoordinates(event);
    if (!coords) return;

    const minX = 0;
    const maxX = Math.min(this.maxDragLimit, this.chart.scales.x.max ?? 5);
    let newX = Math.max(minX, Math.min(maxX, coords.x));

    // Add minimum gap between edges (0.1 seconds)
    const MIN_GAP = 0.1;
    if (this.dragState.edge === 'start') {
      newX = Math.min(newX, this.dragState.visualEnd - MIN_GAP);
    } else if (this.dragState.edge === 'end') {
      newX = Math.max(newX, this.dragState.visualStart + MIN_GAP);
    }

    // Only update if the value has changed significantly
    if (Math.abs(newX - (this.dragState.currentValue ?? 0)) > 0.001) {
      this.dragState.currentValue = newX;
      
      // Update visual values based on the edge being dragged
      if (this.dragState.edge === 'start') {
        this.dragState.visualStart = newX;
      } else if (this.dragState.edge === 'end') {
        this.dragState.visualEnd = newX;
      }

      // Update chart options
      if (this.chart.options.plugins.loopOverlay) {
        this.chart.options.plugins.loopOverlay = {
          loopStart: this.dragState.visualStart,
          loopEnd: this.dragState.visualEnd
        };
      }

      // Force immediate redraw
      this.chart.update('none');
    }
  };

  public handleMouseUp = (event: MouseEvent | TouchEvent): void => {
    if (!this.dragState.isDragging) return;

    event.preventDefault();
    event.stopPropagation();

    // Always trigger onLoopChange when dragging ends to ensure values are properly set
    if (this.onLoopChange) {
      // Update internal state first
      this.loopStart = this.dragState.visualStart;
      this.loopEnd = this.dragState.visualEnd;
      
      // Then notify parent
      this.onLoopChange(this.dragState.visualStart, this.dragState.visualEnd);
    }

    // Reset drag state while preserving visual values
    const { visualStart, visualEnd } = this.dragState;
    this.dragState = {
      isDragging: false,
      edge: null,
      initialX: null,
      currentValue: null,
      visualStart,
      visualEnd,
      isDragFromMargin: false
    };
  };
} 