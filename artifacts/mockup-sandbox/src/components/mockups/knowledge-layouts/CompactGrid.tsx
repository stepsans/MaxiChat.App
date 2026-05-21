import React, { useState, useMemo } from "react";
import "./_group.css";
import { ENTRIES, TYPES, colorForType, labelForType } from "./_data";
import {
  BookOpen,
  Plus,
  Pencil,
  Trash2,
  Upload,
  Download,
  Settings2,
  Search,
  Filter,
  Sparkles,
  Tag,
  MoreHorizontal,
  LayoutColumns,
  Check,
  TrendingUp,
  ChevronDown
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export default function CompactGrid() {
  const [search, setSearch] = useState("");
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());

  // Visible columns
  const [cols, setCols] = useState({
    type: true,
    title: true,
    content: true,
    updatedAt: true,
  });

  const toggleType = (type: string) => {
    const next = new Set(selectedTypes);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    setSelectedTypes(next);
  };

  const filteredEntries = useMemo(() => {
    return ENTRIES.filter((e) => {
      if (search && !e.title.toLowerCase().includes(search.toLowerCase()) && !e.content.toLowerCase().includes(search.toLowerCase())) return false;
      if (selectedTypes.size > 0 && !selectedTypes.has(e.type)) return false;
      return true;
    });
  }, [search, selectedTypes]);

  const toggleAll = () => {
    if (selectedRows.size === filteredEntries.length) {
      setSelectedRows(new Set());
    } else {
      setSelectedRows(new Set(filteredEntries.map(e => e.id)));
    }
  };

  const toggleRow = (id: number) => {
    const next = new Set(selectedRows);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedRows(next);
  };

  return (
    <div className="flex h-screen w-full bg-background text-foreground overflow-hidden font-sans">
      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 border-r border-border">
        {/* Header */}
        <header className="flex-shrink-0 border-b border-border bg-card/50 px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-primary" />
              Knowledge Base
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {ENTRIES.length} total entries • AI uses this data to answer customers
            </p>
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8">
                  <Download className="w-3.5 h-3.5 mr-2" />
                  Export
                  <ChevronDown className="w-3 h-3 ml-2 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem>Export as CSV</DropdownMenuItem>
                <DropdownMenuItem>Export as Excel (.xlsx)</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="outline" size="sm" className="h-8">
              <Upload className="w-3.5 h-3.5 mr-2" />
              Import
            </Button>
            <Button variant="outline" size="sm" className="h-8">
              <Settings2 className="w-3.5 h-3.5 mr-2" />
              Kelola Type
            </Button>
            <Button size="sm" className="h-8 bg-primary text-primary-foreground hover:bg-primary/90">
              <Plus className="w-3.5 h-3.5 mr-2" />
              Add Entry
            </Button>
          </div>
        </header>

        {/* Toolbar */}
        <div className="flex-shrink-0 p-4 border-b border-border bg-background flex items-center gap-4">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-1.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search entries..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-8 bg-muted/50 border-transparent focus-visible:bg-background focus-visible:border-primary"
            />
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 border-dashed border-border/60 data-[state=open]:bg-accent">
                <Filter className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
                Type
                {selectedTypes.size > 0 && (
                  <>
                    <span className="mx-2 h-4 w-[1px] bg-border" />
                    <Badge variant="secondary" className="h-5 px-1.5 rounded-sm bg-primary/10 text-primary font-normal">
                      {selectedTypes.size} selected
                    </Badge>
                  </>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[200px]">
              <DropdownMenuLabel>Filter by type</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {TYPES.map(t => (
                <DropdownMenuCheckboxItem
                  key={t.value}
                  checked={selectedTypes.has(t.value)}
                  onCheckedChange={() => toggleType(t.value)}
                  className="pl-8"
                >
                  {/* Custom Check icon placement inside item */}
                  <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
                    {selectedTypes.has(t.value) && <Check className="h-3.5 w-3.5 text-primary" />}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className={cn("w-2 h-2 rounded-full", colorForType(t.value).split(" ")[0])} />
                    {t.label}
                  </div>
                </DropdownMenuCheckboxItem>
              ))}
              {selectedTypes.size > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem 
                    onSelect={() => setSelectedTypes(new Set())}
                    className="justify-center text-muted-foreground text-xs"
                  >
                    Clear filters
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 ml-auto text-muted-foreground">
                <LayoutColumns className="w-3.5 h-3.5 mr-2" />
                View
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Toggle Columns</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={cols.type} onCheckedChange={c => setCols(prev => ({...prev, type: c}))}>
                Type
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={cols.title} onCheckedChange={c => setCols(prev => ({...prev, title: c}))}>
                Title
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={cols.content} onCheckedChange={c => setCols(prev => ({...prev, content: c}))}>
                Content
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked={cols.updatedAt} onCheckedChange={c => setCols(prev => ({...prev, updatedAt: c}))}>
                Last Updated
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Data Grid */}
        <ScrollArea className="flex-1 bg-background">
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10 shadow-sm outline outline-1 outline-border">
              <TableRow className="hover:bg-transparent border-none">
                <TableHead className="w-12 px-4 h-9">
                  <Checkbox 
                    checked={filteredEntries.length > 0 && selectedRows.size === filteredEntries.length}
                    onCheckedChange={toggleAll}
                    aria-label="Select all"
                  />
                </TableHead>
                {cols.type && <TableHead className="w-[120px] h-9 text-xs font-medium">Type</TableHead>}
                {cols.title && <TableHead className="w-[280px] h-9 text-xs font-medium">Title</TableHead>}
                {cols.content && <TableHead className="h-9 text-xs font-medium">Content Preview</TableHead>}
                {cols.updatedAt && <TableHead className="w-[120px] h-9 text-xs font-medium text-right">Updated</TableHead>}
                <TableHead className="w-16 h-9"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredEntries.map((entry) => (
                <TableRow 
                  key={entry.id} 
                  className="group hover:bg-muted/40 data-[state=selected]:bg-muted border-b border-border/50 h-11"
                  data-state={selectedRows.has(entry.id) ? "selected" : undefined}
                >
                  <TableCell className="px-4 py-1.5">
                    <Checkbox 
                      checked={selectedRows.has(entry.id)}
                      onCheckedChange={() => toggleRow(entry.id)}
                      aria-label={`Select ${entry.title}`}
                    />
                  </TableCell>
                  {cols.type && (
                    <TableCell className="py-1.5">
                      <Badge variant="outline" className={cn("text-[10px] h-5 px-1.5 border-transparent bg-opacity-20", colorForType(entry.type))}>
                        {labelForType(entry.type)}
                      </Badge>
                    </TableCell>
                  )}
                  {cols.title && (
                    <TableCell className="py-1.5 font-medium text-sm truncate max-w-[280px]">
                      {entry.title}
                    </TableCell>
                  )}
                  {cols.content && (
                    <TableCell className="py-1.5 text-xs text-muted-foreground truncate max-w-[400px]">
                      {entry.content}
                    </TableCell>
                  )}
                  {cols.updatedAt && (
                    <TableCell className="py-1.5 text-xs text-muted-foreground text-right tabular-nums">
                      {new Date(entry.updatedAt).toLocaleDateString('id-ID', { month: 'short', day: 'numeric' })}
                    </TableCell>
                  )}
                  <TableCell className="py-1.5 text-right opacity-0 group-hover:opacity-100 transition-opacity">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-6 w-6">
                        <Pencil className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-6 w-6">
                        <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filteredEntries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    No entries found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollArea>
        
        {/* Footer Stats */}
        <div className="flex-shrink-0 border-t border-border bg-card/30 p-2 px-4 flex items-center justify-between text-xs text-muted-foreground">
          <span>{filteredEntries.length} entries shown</span>
          {selectedRows.size > 0 && (
            <span className="text-primary font-medium">{selectedRows.size} selected</span>
          )}
        </div>
      </div>

      {/* Right Rail: AI Usage Stats */}
      <div className="w-[280px] flex-shrink-0 bg-card/20 flex flex-col border-border border-l-0">
        <div className="p-4 border-b border-border/50">
          <h3 className="font-medium text-sm flex items-center gap-2 text-foreground">
            <Sparkles className="w-4 h-4 text-primary" />
            AI Usage Insights
          </h3>
          <p className="text-xs text-muted-foreground mt-1">Most referenced by AI this week</p>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-4">
            {[
              { id: 1, title: "Promo Bundle Mei 2026", hits: 342, trend: "+12%" },
              { id: 2, title: "Berapa lama pengiriman sampai?", hits: 289, trend: "+5%" },
              { id: 3, title: "Maxipro Hair Serum 30ml", hits: 156, trend: "-2%" },
              { id: 4, title: "Apakah aman untuk ibu hamil?", hits: 89, trend: "+8%" },
              { id: 5, title: "Link katalog & order form", hits: 64, trend: "0%" },
            ].map((stat, i) => (
              <div key={i} className="flex flex-col gap-1.5 p-3 rounded-lg bg-card border border-border/50 hover:border-border transition-colors">
                <span className="text-sm font-medium line-clamp-1">{stat.title}</span>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground flex items-center gap-1">
                    <Tag className="w-3 h-3" />
                    {stat.hits} refs
                  </span>
                  <span className={cn("flex items-center gap-1", stat.trend.startsWith('+') ? "text-emerald-500" : stat.trend.startsWith('-') ? "text-destructive" : "text-muted-foreground")}>
                    {stat.trend.startsWith('+') && <TrendingUp className="w-3 h-3" />}
                    {stat.trend}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
