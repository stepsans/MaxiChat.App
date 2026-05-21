import React, { useState, useMemo } from "react";
import "./_group.css";
import { ENTRIES, TYPES, colorForType, labelForType } from "./_data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
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
  ChevronRight,
  Sparkles,
  Tag,
  MoreVertical,
  Calendar
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export default function SidebarMasterDetail() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<number>(ENTRIES[0]?.id);

  const filteredEntries = useMemo(() => {
    return ENTRIES.filter((entry) => {
      const matchesSearch = entry.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
                            entry.content.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesType = selectedType ? entry.type === selectedType : true;
      return matchesSearch && matchesType;
    });
  }, [searchQuery, selectedType]);

  const selectedEntry = useMemo(() => {
    return ENTRIES.find(e => e.id === selectedEntryId) || null;
  }, [selectedEntryId]);

  return (
    <div className="min-h-screen w-full bg-background text-foreground flex flex-col font-sans">
      {/* Top Header Strip */}
      <header className="flex-shrink-0 h-16 border-b border-border bg-sidebar/50 backdrop-blur-sm px-6 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-primary">
            <BookOpen className="w-5 h-5" />
            <h1 className="text-lg font-semibold tracking-tight">Knowledge Base</h1>
          </div>
          <Separator orientation="vertical" className="h-6" />
          <Badge variant="secondary" className="text-xs font-normal">
            {ENTRIES.length} entries total
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="h-9">
                <Download className="w-4 h-4 mr-2" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem>Download CSV</DropdownMenuItem>
              <DropdownMenuItem>Download Excel</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button size="sm" variant="outline" className="h-9">
            <Upload className="w-4 h-4 mr-2" />
            Import
          </Button>
          
          <Button size="sm" variant="outline" className="h-9">
            <Settings2 className="w-4 h-4 mr-2" />
            Kelola Type
          </Button>

          <Button size="sm" className="h-9 bg-primary text-primary-foreground hover:bg-primary/90">
            <Plus className="w-4 h-4 mr-2" />
            Add Entry
          </Button>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar (Master) */}
        <aside className="w-[380px] flex-shrink-0 border-r border-border bg-sidebar/30 flex flex-col">
          {/* Filters & Search */}
          <div className="p-4 space-y-4 border-b border-border bg-sidebar/50">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input 
                placeholder="Search knowledge base..." 
                className="pl-9 h-9 bg-background/50 border-border/50 focus-visible:ring-1"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            
            <ScrollArea className="w-full whitespace-nowrap" orientation="horizontal">
              <div className="flex items-center gap-1.5 pb-2">
                <Badge 
                  variant={selectedType === null ? "default" : "outline"}
                  className={cn(
                    "cursor-pointer transition-colors px-3 py-1",
                    selectedType === null ? "bg-primary text-primary-foreground" : "hover:bg-muted/50 text-muted-foreground"
                  )}
                  onClick={() => setSelectedType(null)}
                >
                  All Types
                </Badge>
                {TYPES.map(type => (
                  <Badge
                    key={type.id}
                    variant="outline"
                    className={cn(
                      "cursor-pointer transition-colors px-3 py-1 border-transparent",
                      selectedType === type.value 
                        ? colorForType(type.value).replace("bg-", "bg-").replace("/10", "/20")
                        : "bg-muted/30 text-muted-foreground hover:bg-muted/50"
                    )}
                    onClick={() => setSelectedType(type.value)}
                  >
                    {type.label}
                  </Badge>
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* List */}
          <ScrollArea className="flex-1">
            <div className="p-3 space-y-1">
              {filteredEntries.length === 0 ? (
                <div className="py-12 text-center text-muted-foreground flex flex-col items-center">
                  <Search className="w-8 h-8 mb-3 opacity-20" />
                  <p className="text-sm">No entries found</p>
                </div>
              ) : (
                filteredEntries.map(entry => {
                  const isSelected = entry.id === selectedEntryId;
                  return (
                    <button
                      key={entry.id}
                      onClick={() => setSelectedEntryId(entry.id)}
                      className={cn(
                        "w-full text-left p-3 rounded-lg transition-all duration-200 group flex flex-col gap-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                        isSelected 
                          ? "bg-primary/10 ring-1 ring-primary/30" 
                          : "hover:bg-muted/50 border border-transparent"
                      )}
                    >
                      <div className="flex items-start justify-between w-full gap-2">
                        <Badge 
                          variant="outline" 
                          className={cn("text-[10px] shrink-0 border-transparent", colorForType(entry.type))}
                        >
                          {labelForType(entry.type)}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground/60 whitespace-nowrap pt-0.5">
                          {entry.updatedAt}
                        </span>
                      </div>
                      
                      <div className="space-y-1 w-full">
                        <h4 className={cn(
                          "font-medium text-sm leading-tight line-clamp-1",
                          isSelected ? "text-foreground" : "text-foreground/90 group-hover:text-foreground"
                        )}>
                          {entry.title}
                        </h4>
                        <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                          {entry.content}
                        </p>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </aside>

        {/* Right Detail Pane */}
        <main className="flex-1 flex flex-col bg-background/50 relative overflow-hidden">
          {selectedEntry ? (
            <>
              {/* Detail Header */}
              <div className="px-8 py-6 border-b border-border/50 flex items-start justify-between gap-6 shrink-0 bg-background z-10">
                <div className="space-y-3 flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <Badge 
                      variant="outline" 
                      className={cn("px-2.5 py-0.5 text-xs font-medium rounded-full", colorForType(selectedEntry.type))}
                    >
                      <Tag className="w-3 h-3 mr-1.5 opacity-70" />
                      {labelForType(selectedEntry.type)}
                    </Badge>
                    <div className="flex items-center text-xs text-muted-foreground gap-3">
                      <span className="flex items-center"><Calendar className="w-3.5 h-3.5 mr-1" /> Created {selectedEntry.createdAt}</span>
                      <span className="opacity-30">•</span>
                      <span>Last updated {selectedEntry.updatedAt}</span>
                    </div>
                  </div>
                  
                  <h2 className="text-2xl font-semibold tracking-tight text-foreground leading-tight">
                    {selectedEntry.title}
                  </h2>
                </div>
                
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="outline" size="sm" className="h-9">
                    <Pencil className="w-4 h-4 mr-2" />
                    Edit
                  </Button>
                  <Button variant="outline" size="icon" className="h-9 w-9 text-destructive hover:text-destructive hover:bg-destructive/10 border-transparent hover:border-destructive/20">
                    <Trash2 className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-9 w-9">
                    <MoreVertical className="w-4 h-4 text-muted-foreground" />
                  </Button>
                </div>
              </div>

              {/* Detail Content */}
              <ScrollArea className="flex-1">
                <div className="p-8 max-w-4xl mx-auto">
                  <div className="prose prose-sm md:prose-base prose-invert max-w-none">
                    <p className="text-foreground/80 leading-relaxed whitespace-pre-wrap text-[15px]">
                      {selectedEntry.content}
                    </p>
                  </div>
                  
                  {/* Decorative AI indicator */}
                  <div className="mt-12 flex items-center gap-2 p-4 rounded-xl bg-primary/5 border border-primary/10">
                    <div className="bg-primary/20 p-2 rounded-lg text-primary">
                      <Sparkles className="w-4 h-4" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">AI is using this entry</p>
                      <p className="text-xs text-muted-foreground">The assistant has full context of this information for answering queries.</p>
                    </div>
                  </div>
                </div>
              </ScrollArea>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
              <BookOpen className="w-12 h-12 mb-4 opacity-10" />
              <p className="text-lg font-medium text-foreground/50">No Entry Selected</p>
              <p className="text-sm mt-1">Select an item from the sidebar to view details</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
